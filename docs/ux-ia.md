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
- **Pending across the workspace (2026-11-24, [ADR 0064](adr/0064-pending-count-and-asset-hint.md))**: the Workspace group of the left panel has a **Pending** entry (after
  All apps and Inbox; needs `listing.read`) with the count of every app's pending cart as a `nav-count` badge (accent, `99+` above 99; a small badge on the
  collapsed rail; none while unknown or zero). Its accessible name says "12 pending changes across 4 apps" (items of the carts across products). The page
  (`#/pending`, `WorkspacePending`) lists one row per app with its count and kinds and an "Open cart" button that goes to the app and opens that app's cart
  drawer; there is no publish or discard here and nothing across apps. Each row has an expand chevron that lists the individual changes of that app (read lazily from the per-app cart; the summary stays counts only), each expandable to the same
  preview as in the cart drawer (text diff, before and after images, price table, reply with its review) with Expand all / Collapse all, so changes can be reviewed across apps without opening each cart ([ADR 0067](adr/0067-diff-and-preview.md)). The count (`GET /pending/cart-summary`) is read on first paint, on window focus
  (at most every 30 s) and once after `kiln:staged-changed` (debounced; publish, discard, stage, reply drafts): no polling.
- **Asset proposal on the Releases list (2026-11-24)**: under the Prepare release card, a quiet line "3 store asset changes proposed" with "Review" (opens
  the Assets step, where the card lives), per record with a repository, only when something is proposed and it was not skipped for the release. A cached
  count (`GET .../release/asset-proposal/summary`), asked after the page drew; nothing is drawn while unknown, unavailable or failed.
- **The header follows the focused app**: Sync, its menu, the Status popover and "Updated X ago" belong to the app in the address. On an app change the run
  state, the readings, the open menu and the cart drawer of the previous app are dropped and a late answer of the old app is ignored
  (`lib/sync-scope.ts`); a run left over from the previous app never keeps the new app's Sync busy.
- **Collapsible left panel (2026-11-23)**: on wide screens (900px and up) a chevron in the panel head, or Cmd or Ctrl + B, folds the panel to a
  64px rail (`--sidebar-rail-width`): logo mark, workspace initials, the app icon (opens the panel to switch app), one tinted mark per platform,
  and the entries as icons with their count as a small badge. Every entry keeps its label for assistive technology (visually hidden) and a `title`
  tooltip; `aria-current` styling is untouched. The choice is stored per person in `localStorage` (`kiln.sidebar.collapsed.<userId>`, in try/catch;
  `lib/sidebar-state.ts`); the width animates unless `prefers-reduced-motion`. Under 900px the panel stays the drawer and is always whole.
- **Section rail (2026-11-23)**: `components/ui/SectionRail.svelte` (+ `lib/section-rail.ts`) is the Settings pattern as a reusable part: grouped entries
  on the left (each a real link, optional count), one section at a time on the right, kept in the address as `?section=` (an old `?view=` still resolves:
  `resolveRailSection` takes aliases). Arrow keys, Home and End move focus along the rail; under 48rem it is a strip of tabs that scrolls sideways. The
  app **Builds** page uses it (`lib/builds-sections.ts`): Builds, Test builds | EAS submissions (count), EAS configuration, EAS updates (only for an app
  linked to Expo / with a repository) | Workflows. `?view=builds|tests|workflows` open the same sections. EAS submissions is its own section
  (`EasSubmissionsPanel`), no longer under Test builds.
- **Test builds install dialog (2026-11-24)**: Install on an EAS row opens a modal (`EasInstallDialog`, shared `Modal`: focus trap, Escape, focus returns to the
  button) like Expo's own: a lead sentence per platform, a locally drawn QR code of the build page (`QrCode`, always black on white, aria-label "QR code for the install
  link"; the address field is its text alternative), the address read-only with Copy ("Copied" is announced), Open on Expo, collapsible platform help (Android unknown
  sources by Android version; iOS registered device and trust, link to Expo's internal distribution docs), the expiry date, and, when the server hands out the file
  address (download switch on and `builds.download`), Download build and, on desktop only, Open with Orbit (tooltip "Needs Expo Orbit installed"; after a click a
  hint with the Orbit download link). A build that cannot be installed (running, failed, expired, store, no address) shows Install disabled with the reason beside it.
  CI and store rows keep the inline install steps. [ADR 0061](adr/0061-eas-install-dialog.md), [api/eas-builds](api/eas-builds.md).
- **Insights overview, one hierarchy (2026-11-23)**: no separate figures band above the rail (it read as two pages stacked). From the top: header (app,
  scope, Sync) > the tabs (Overview, Highlights, ...) > the range bar (range and table switch) > [sticky **section rail** (`?section=`) | content]. The rail is
  drawn only with two or more sections; Acquisition, Quality and Revenue exist only when something is stored. The **Overview** section starts with the
  headline, built by the pure `lib/analytics/insights-view.ts` (tested for no data, one platform, both, analytics off, failed and loading): with data on
  two platforms ONE comparison table (a row per measure, a column per platform, `CompareTable`); with data on one, a uniform grid of tiles (equal width and
  height, `StatRow`); a platform with no data is ONE compact line (why, and "Open Data sources"), never an empty column; then the RevenueCat figures ONCE
  for the whole scope (`RevenueBlock` with `appIds`, read from the first linked record), then the headline chart of each platform with data (side by side
  from 72rem only when two have data). The other sections draw only the platforms that have data. Counts show the cards of a section and the sources that
  could not be read. Every chart card is in exactly one section (`lib/analytics/sections.ts`, tested). **Data sources is ONE panel for the scope**
  (`SourcesPanel` with `items`): one summary (worst state, last read), a heading per platform only when there are several, one import button per platform.
  What is read per platform lives in `PlatformData` (one read, shared by the figures and the sections).
- **Sync is per page (2026-11-23)**: the header has ONE split button, `SyncButton` (`lib/sync-plan.ts`, pure and tested). The main action reads only what the
  page needs and what is not fresh: Insights its analytics sources (failed first; a source read within 6 hours is left alone), Reviews the reviews, Products the
  products with RevenueCat, Builds EAS and TestFlight, every other page the store listing. Its label says what it does ("Sync analytics"); when something the page
  reads failed it becomes "Retry failed (2)" and reads only those; with nothing due it still works and reads the page again. The chevron opens the menu:
  "Sync everything", "Only failed (n)" when any failed, and one row per kind with its last read and its own Sync (the other kinds are read from their stored
  status only once the menu is opened). While it runs the button says "Syncing 3 of 5"; progress and failures stay in the Status popover. Insights, Data sources gives
  a failed source its own small **Retry** (`POST /analytics/sync` with `sources`). A source that needs a permission shows its real cause and ONE guide with real
  links instead of "sync again": the Play service account address with a copy button, Play Console Users and permissions and the exact bucket's
  permissions page, the App Store Connect vendor number page and Users and Access, plus the vendor number field (kept per Apple credential) and
  **Test access** (one call, a classified answer). A refused source is a fault to fix, not "Optional setup". See [Troubleshooting analytics sources](troubleshooting-analytics.md). The server takes the same granularity: `POST /apps/:id/sync-all?kinds=reviews,analytics&sources=...`.
  Everything below about the queue order still applies to "Sync everything".
- **One Sync (2026-11-23)**: "Sync everything" (the menu of the header Sync; it was the only button before the split). For every record in scope it runs, in order: the store listing and release state
  (directly, so the releases are on screen when it ends), then the rest through the server queue in one request (`POST /apps/:id/sync-all?without=app`: reviews,
  EAS, analytics, critical first, [ADR 0050](adr/0050-sync-pipeline.md)), then products with the RevenueCat figures and TestFlight feedback (no queue yet;
  `lib/sync-all.ts`). Each kind the role may not run, or that does not apply, is left out and said. The **Status** popover is the single place for details:
  `SyncSources` lists every source (name, state in words, last read, what to try, per platform when several) and shows each kind's progress while a run goes
  (`lib/sync-run.svelte.ts`). Pages no longer carry sync buttons (Insights "Sync analytics now", reviews, products, TestFlight, test builds "Read again" are gone):
  a quiet `UpdatedLine` says "Updated 5 minutes ago" for the sources the page shows, or "Could not read: reviews" with a "See Status" button. What stays: first-time setup
  (connect, enable, Apple analytics) and file imports (a Play Console CSV or Apple report, in Insights, Data sources). `apps.sync` still gates the header Sync (and each kind its own right, so a role sees only what it may run);
  each kind also needs its own right (`reviews.sync`, `analytics.manage`). Pure logic: `lib/sync-sources.ts`, `lib/sync-all.ts` (tested).
- **Views inside a page** (`ViewSwitch`, `?view=` in the address, platform, version and locale stay): Store listing = Text, Graphics;
  Insights = Overview, Highlights (the Insights cards, with the count badge on the Insights entry), Countries (downloads by main language against the languages of the store page), Keywords, Search terms (phase 2, see 0a), Ads (Apple Ads, App Store records only), Experiments (`?view=experiments`, every platform: Apple tests and custom product pages, Google link-out and the manual tracker); Builds = Builds,
  Workflows, Test builds; Reviews = Reviews, TestFlight (`?view=testflight`, `reviews.read`, only when an Apple app is in scope: beta feedback and crashes).
- **Old addresses redirect** (`canonicalAppHash`, replaces the history entry): `/workflows` to `/builds?view=workflows`,
  `/test-builds` to `/builds?view=tests`, `/assets` to `/listing?view=graphics`, `/analytics` to `/insights`, `/aso[?view=x]` to
  `/insights?view=keywords|x`. `/pending`, `/settings` and `/release/<version>` stay. The `g` chords keep their letters
  (`g i` is Insights; `g a`, `g o`, `g n`, `g w`, `g t` still work through the redirects).
- **One slim header per page** (`AppShell`): page name and app name, the platform control (only for an app on several platforms, not
  on app settings), the version and locale pickers only on Releases and Store listing, and a **Status** button (`StatusPopover`) that
  holds the Repository and Store live chips, each store record with its full bundle id (wraps, never truncated), the last sync and the
  one **Sync now** action (since 2026-11-23 the Status popover has no button: see "One Sync" below).
- **Price changes** (ADR 0062; `PriceEditor` on the product page, `CartPriceDetail` and the price confirm in the cart): "Edit price" opens a table per
  plan (territory, current price, new price typed as money in the territory's own currency, the change in percent in words and never by colour
  alone). Apple shows the nearest price points when an amount is not one; Google Play offers "Convert from one base price". A date field exists only
  for Apple. Existing subscribers are a radio group with `preserve` first and marked default, each choice with its consequence in plain words; each guard
  rail that applies is its own required checkbox. Saving only stages ("Added to pending changes"). Unavailable states keep the prices visible and say
  why next to a disabled button: a role below admin, the server switch (`KILN_PRICE_WRITES_ENABLED`), the workspace setting (owners and admins get a
  button to turn it on or off). RevenueCat prices carry a read only note. In the cart a price row shows before and after per territory (counts per
  currency, never a total), the date and the subscriber choice; the confirm names the count, warns that stores take time to show a price, and asks
  for the typed phrase (one field per record); "Check prices with the store (dry run)" shows per item what would be sent. After a send each row says
  "Confirmed by the store" or "Store shows X for T, not Y". Dark tokens only (`--warn-*`, `--bad-ink`, `--ok-ink`); all strings in four languages.
- **Pending cart** (`PendingCart`, `PendingCartDrawer`; replaces the pending bar, ADR 0054): a compact button in the top bar of every app page, next to the account menu
  (`PendingCartButton`; it never floats over page content, so it cannot cover a primary button), showing how many changes wait (upload icon, "Pending"
  and the count; icon and count only below 600px; hidden with none, on the pending page and outside an app; its name and tooltip say "this app" to
  tell it from the workspace-wide Pending entry of the navigation, ADR 0064). Opening it shows the right drawer (header and footer fixed, the body scrolls): items grouped by kind (Store listing,
  Graphics, Release details, Review replies), a checkbox per row, platform and language chips, the new text with what the store has now ("before → after"),
  who and when, and **Open** to the page where it was made. Every row has an expand chevron (`aria-expanded`, collapsed by default, kept while the drawer is open; **Expand all / Collapse all** above the list) that shows the
  preview of the change, read lazily ([ADR 0067](adr/0067-diff-and-preview.md)): a text diff (store text against the staged text, inline or side by side, characters before → after with the store limit), before and after
  images (a click opens the image viewer: side by side, swipe, fade, difference), the release field's staged value, the price table, or the reply draft with the review it answers. Select all; **Publish N selected** and **Discard selected** each ask first and say how many
  and to which stores. After a run every item shows Done, Failed or Skipped with a reason; partial success is normal and what failed stays in the cart.
  When a page stages something the button pulses once (not with reduced motion), a toast says "Added to pending changes" and the count is announced
  politely. What publish does: staged changes are written to the store as a **draft** (nothing is submitted; they are sent together, so they are
  selected together), a reply is public at once. Rights: a row the person cannot send (no right, switch off, an error) is listed with its reason and
  cannot be selected. Submit, release and rollout stay on the publish page (linked from the drawer). Replies come from the existing reply drafts.
  On the Overview the changes are also one link under the primary button of the Next step card (`pendingPlacement` in `lib/app-page.ts`).
- **Revenue, Expo card and EAS steps (2026-11-23)**: the RevenueCat figures (active subscriptions, trials, MRR, 28-day revenue, "As of", the
  "key may not read metrics" sentence) are the Revenue block of the Insights overview (`RevenueBlock`, only for a RevenueCat-linked app); Products keeps
  configuration and one small link to Insights. The app Overview has an Expo (EAS) card per platform (latest build and submission, stored data only,
  empty states for "not linked" and "no builds yet"); the release detail shows the matching EAS build and submission as steps under each store
  release. Failed EAS builds and submissions raise alerts ([alerts](alerts.md)).
- **OTA state (2026-11-24)**: the Expo card of the Overview also shows "Current update per channel" from the stored read (rollout badge, runtime version, time,
  link to Expo and to Builds, EAS updates; "Updated X ago"; empty states for never read and none for this platform). The release detail adds a quiet
  line "OTA update published" under the EAS steps only when the stored update of the build's channel has the build's exact runtime version. A rollout that
  stays unchanged below 100% raises `eas.update_rollout_stuck` ([ADR 0060](adr/0060-eas-update-state.md)).
- **Next step card** (`NextStep`, Overview and Releases): one primary button chosen by state, in this order: a release whose step
  failed (rejected), a release that waits for you (finish, attach a build, release it), a release in store review (quiet "Start release"
  beside it), then with nothing on its way "Start release" (or "Prepare release" without a linked repository). The five release steps,
  the other releases on their way are inside the card ("Your next step", 30px title, one large button); on the Overview the rest of "Needs attention" is its own card "Also worth a look" under the platform cards (Releases keeps it in the card), so the old "waiting for you" strip, the separate
  "Needs attention" card and the Prepare release / Open the release steps buttons are gone. Overview then shows the platform
  cards side by side (tint on the left edge, name, what is on the store, the version in flight with its status, "Open releases") and a collapsed Details (bundle ids, last sync, analytics).
  **Promote** ([ADR 0025](adr/0025-play-release-checks.md)): on an Android app a release that serves users from a track that is not production
  gets "Promote to production" in its Releases row (platform cell), in the row's details and as one quiet line in the Next step card. It
  opens Prepare release on the Build step with the source track, the target and the version codes selected (`&from=internal&to=production&codes=241`).
  **Store assets changed in the repository** ([ADR 0063](adr/0063-release-asset-proposal.md)): the Assets step of Prepare release opens with a card that
  lists the texts and graphics that changed in the repository since the previous release and still differ from the store and the cart. The findings of the
  listing checks and the graphics rules come first (errors, warnings, tips collapsed), then the items with a checkbox (items without errors checked, items
  with errors unchecked, marked "Has issues", staged only after a confirmation), then "Stage selected", "Skip for this release" and "Remind me later" (saved
  per release). Each text has a **Diff** button (store text against repository text, previous and next across the list) and each graphics set opens the image viewer (store images against repository images). Nothing is staged without the click; afterwards "Open pending changes" opens the cart. Hidden when there is no repository or nothing changed.
  Not on the Releases list or the Timeline.
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
  developer response, language, country, version, written; the inbox adds store and assignee, and has its own Apps combobox in the toolbar; the translation toggle lives
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

- **Collapsible sections** (`ui/Section.svelte`, one primitive; `Card` takes it with `collapseKey`; `SettingsCard` is always open (0d)): the head is a button
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

## 0c. Workspace Settings: a rail and one section at a time (built)

`#/settings` was one list of twelve cards, then four views behind a segmented control with a "Jump to" row, with cards that opened
collapsed. It is now two panes, like the preferences of Slack and VS Code: a rail on the left (a search box, then sections in groups)
and one section at a time on the right, kept in the address as `?section=`. Pure logic: `settings-views.ts` (`settingsGroupsFor`,
`filterSettingsGroups`, `resolveSettingsSection`, `withSettingsSection`, `isFormSection`).

| Group        | Sections                                                           | Save                                  |
| ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| Workspace    | Store refresh, Reviews, Releases, Translation, Analytics           | one form, one "Save settings" bar     |
| Just for you | Language (this browser)                                            | applies at once                       |
| Security     | Confirm hard actions (with recovery codes), Authenticator and email, Mail server (admins) | each card saves on its own |
| AI           | AI assistant (`ai.use`), Connect an AI assistant                   | own save                              |
| Integrations | Slack and Teams (the `#/chat` screen, drawn here), Webhooks (`#/webhooks`) | destinations save on their own; Webhooks is a link |

- `#/settings` is Store refresh. The old `?view=general|analytics|security|ai` addresses (emails, other pages) open the first section of
  that view, so nothing that links to them breaks.
- The rail is sticky, has a search (matches a section name, its group name or the keywords of the section, e.g. "smtp" or "deepl"; Enter opens the first match) and marks the form sections with a
  dot while changes are unsaved. Under 48rem it stacks above the section.
- Cards are drawn open and without a toggle on this page (`provideFlatCards`, read by `Card`): a section is alone on screen.
- Role gating is unchanged: a role without `settings.read` only gets Language and Connect an AI assistant (plus AI assistant with
  `ai.use`); Mail needs `settings.write`; Slack and Teams needs `chat.read`. The nav item and `#/chat` stay (same screen; `Chat` takes `embedded` inside Settings).
- The workspace form keeps one state held by the page and one save bar under the open section, so a change of section keeps what was
  typed. On the other sections a note says changes are waiting, with a link. A save blocked by a value in another section says which.

## 0e. Tabs, rail, scope, sync: the one hierarchy of a page

Every app page reads top to bottom in the same order, so two pages never seem stacked:

1. **Header**: the app, the platform **scope** (iOS | Android | All) and the page's **Sync** (0, "Sync is per page"). Scope and sync live only here.
2. **Tabs** (`SegmentTabs`, `?view=`): the **pages** of a section (Insights: Overview, Highlights, Countries, Ratings and health, Timeline, Keywords, Search terms, Ads, Experiments). Timeline (`?view=timeline`, every role) has a rail with Timeline and Reports (`?section=reports`) and syncs the app, reviews and analytics (docs/adr/0053-timeline-and-reports.md); Ratings and health (`?view=ratings`, needs `reviews.read`) keeps the rule: its rail (`?section=ratings|reviews|stability|releases|countries`) lists sections, its page Sync reads reviews and analytics (docs/adr/0052-ratings-health.md).
3. **Range bar** (and table switch): one bar under the tabs, for the pages that have a date range. Nothing above it repeats scope or sync.
4. **Rail | content** (`ui/SectionRail`, `?section=`): the **sections inside one page** (Insights Overview, Builds, app Settings, workspace Settings). The rail is
   sticky, drawn only with two or more sections, and the content scrolls beside it; a section that would be empty for the data at hand is not listed.

Competitor listing changes ([ADR 0056](adr/0056-competitor-listing-watch.md)) follow the same hierarchy and add no tab: they are a collapsed "Listing changes" part of each competitor card in Insights, Keywords, Competitors
(before and after strips, collapsed word diffs, "Check now", left aligned rows that wrap instead of scrolling sideways), a `competitor_change` event on the Timeline tab (its filter chip is the kind label) and an optional alert.
Google Play competitors show "not watched" with the reason: Kiln does not read Google Play pages.

Listing fixes ([ADR 0059](adr/0059-listing-fixes-via-cart.md), [api/listing](api/listing.md#one-click-fixes-of-the-listing-checks)): a finding of the listing checks that has a mechanical fix gets a **Fix** button (Store listing, the checks card, and the locale panel's "Fixes for this language"), plus **Fix all that can be fixed (N)** per language and for the app. A fix opens a small review (removed keyword terms struck through, a word diff for text, the counter) and **Stage fix** puts it in the pending changes (the cart pulses, toast "Added to pending changes"); nothing is published without the cart's review. The finding then says **Fix staged** with **Discard**, and the counts say "after pending changes". Prose is never shortened automatically: an over-long text offers **Shorten with AI** (only when AI is on; the person accepts) and the editor with the limit counter; an empty required field opens the editor. Off, with the reason in words: a locked version, no right to stage, the App Store name and subtitle.

Apple Ads ([ADR 0058](adr/0058-apple-ads.md), read only) is one Insights tab, **Ads** (`?view=ads`, `aso.read`, App Store records only), with the rail rule of every page: header (scope, Sync, which syncs the Apple Ads reports), range bar and "Updated" line, then a rail (`?section=overview|campaigns|terms|keywords|account`). An app not linked to an ad account gets one setup card (steps and the link form) instead of the rail. Tables are left aligned `table.fit`, the search terms table sorts by clicking a heading and offers "Track keyword"; money is shown in the one currency of the ad account and a missing ratio is a dash. The link form is also in the app Settings, Integrations. It adds no alert.

Keyword estimates ([ADR 0057](adr/0057-keyword-estimates.md)) follow the same hierarchy and add no tab: an "Estimates" section and a "Related terms" section under the tracked keywords of Insights, Keywords (a `table.fit`, a detail panel instead of a new page); every figure is labelled an estimate and links to its "How this is estimated" popover.

Rules: tabs are pages and the rail is sections, never both for the same level; a block with no data is one compact line saying why and how to fix it, not an
empty column; with several platforms prefer one comparison (a row per measure) to repeating long runs, and draw side by side only what both have; tiles sit in a
uniform grid. Pages with tabs and sections follow the Insights Overview; Builds, app Settings and workspace Settings already use the rail without tabs.

## 0d. App settings: a rail and one section at a time (built)

The settings of an app (`#/apps/:id/settings`) used to be one long column of collapsible cards under a "Jump to" row. They now follow the workspace Settings
(0c): `ui/SectionRail` on the left, one section on the right, kept in the address as `?section=`. Pure logic in `lib/app-settings.ts`
(`appSettingsGroups`, `appSettingsSections`, `resolveAppSettingsSection`).

| Group       | Sections                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| Connections | Stores (credentials), Repository, Expo and RevenueCat                     |
| Releases    | Release defaults, Google Play releases (Android records only)             |
| Data        | Reports bucket (Android only), Notifications, AI assistant (when it is on), Privacy and AI (when it is on) |
| Removal     | Danger zone (roles that may delete)                                       |

- The address opens the first section (Stores); an old element id (`?section=app-settings-repository`, also in `?view=`) opens the same section; a section the
  app does not have opens the first one. A group with no entry is not drawn.
- Every card is open: `SettingsCard` has no toggle and no remembered state, and its "not available yet" reason is a plain muted line. Disclosure remains only for
  genuinely secondary technical detail. Each form keeps its own sticky save bar (`SaveBar`) inside its section.
- Expo and RevenueCat draw nothing when they do not apply; if both are empty one line says so.
- The "Jump to" row and the expand/collapse-all toggle are gone from this page (nothing to jump to or fold).

### Next: Graphics and the store listing

- The Graphics tab shows the store's own images first (`GET /assets/store`, read only, the cached read of the last minute; `checkStoreImages` in
  `@kiln/core` holds them against the documented specs). The repository's graphics appear only with the per-app setting "Compare repository and store graphics" (default off).
- Not built: "Replace image" on a store screenshot. A staged set is the whole set and starts from repository files; replacing one store image needs a pull of the set into a staged set first. Do it as a staged action, never a direct upload.
- Custom product pages are shown read only on the Store listing page (the stored copy of Insights > Experiments). Google Play has no API for custom store listings; the data is Apple only.

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

### Where staged state shows, and how it stays true

- **One invalidation** (`lib/staged-sync.ts`): every stage, unstage, discard (cart or field) and publish goes through `api.ts`, which announces
  `kiln:staged-changed`; ONE listener in `AppShell` reads `stagedStore` and `pendingStore` again for those apps and the cart reads its list. Screens
  read the stores and never keep their own copy, so the listing grid, the locale panel, the Graphics tab, the overview hint and release pages agree.
- **Listing grid:** a cell with a staged text shows an "Edited" pill (dot and word, tooltip and aria text `Staged: before → after`); a locale row shows
  "N staged", which opens the cart drawer on that locale's items (`kiln:cart-open`). In the locale panel a staged field shows a "Staged" badge and
  "Discard" (the cart discard); fields without a staged value show nothing.
- **Per-app Pending changes page** (`PendingChanges`, 2026-11-24, [ADR 0067](adr/0067-diff-and-preview.md)): every row has an expand chevron (a button with `aria-expanded` and `aria-controls`, collapsed by default) and each platform
  group has "Show all previews" / "Hide all previews" next to "Discard all staged". A staged row previews through its cart items with the same shared component as the cart drawer (text diff, before and after images
  with the viewer); a pushed draft, draft release, version in review or approved and due rollout step show what they contain and what happens next (`GET /apps/{id}/pending/detail`, stored state only); an unknown kind says
  "No preview for this kind of item". Graphics rows name the language (`Feature graphic (en-US): 1 file`) and show their first thumbnails inline when collapsed. Not viewed in a browser.
- **Field editor:** "Stage in <field>" closes the modal on success (focus returns to what opened it) and stays open with the reason on failure.

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

- **Insights cards, store page checks and country coverage** (`components/insights/`, `lib/insights/insights.ts`; strings in `locales/insights`).
  Highlights: filter chips with counts, one card per finding (severity icon and word, headline, why, evidence, one or two buttons that open Kiln pages,
  Dismiss with an Undo toast), and a note for each rule that could not run and why. The badge on the Insights entry is one `.../insights/count` read per record
  when an app is opened (again only after five minutes; Highlights keeps it exact); no timer. The entry always opens on Overview; the badge counts the open cards, which are on the Highlights tab. The store page
  checks sit under the locale grid of Store listing, Text (score, findings per language, a suggested keyword field with a copy button; nothing is staged
  or sent). Countries: bars by main language ("On your store page" or a link to the listing) and a table with the main language of each country.

## Privacy and AI, and scheduled competitor reads (2026-11-24, [ADR 0065](adr/0065-ai-review-privacy-and-competitor-schedule.md))

- App settings, Data group, **Privacy and AI** (`?section=ai-privacy`, after "AI assistant"): own and competitor reviews as inherit / allow / do not allow (inherit shows the
  workspace value; a kind the workspace turned off is shown locked with the reason), what is sent (text without names, full, ratings only), the redaction checkbox, a save bar,
  **Preview payload** (a `<pre>` of the first 3 reviews) and **Delete AI summaries for this app** (a confirm Modal). Roles without `apps.write` read it. Workspace ceiling: Settings, AI, "Reviews and AI".
- Reviews page, AI row: when the app or workspace turned it off the buttons are replaced by a notice with the reason and a link to the setting (`data-testid="ai-reviews-off"`);
  stored summaries stay visible with a note. In ratings-only mode the fix-next and tag buttons are hidden and a line says the summary is statistical.
- ASO, Competitors: a **Scheduled reads of reviews** panel after the followed count: Off / Daily / Weekly (weekday), time zone (UTC or yours), competitors per run, newest reviews per read, Pause and
  Resume, the next run, an Apple-only note (Google Play has no official API), and one line per competitor ("Reads every Monday, last read 2 days ago, 3 new reviews", next run, failure reason) with an
  override select. Rights `aso.write` to change, `aso.read` to see. Not viewed in a browser.

## Prepare release, Assets step: reads that always end (2026-11-24, [ADR 0066](adr/0066-assets-step-bounded-reads.md))

- Every read and the staging of the step is bounded (server 25 s / 45 s, client 30 s / 60 s); a failure is a translated message with "Try again", "Compare again" is the same retry and is disabled only while a request is in flight.
- The screenshot comparison is a compact table per language and device (repository, store, status, link to Graphics), or "No repository linked" / "Nothing to compare". It does not need the `compareMedia` setting. The proposal card's rows are `AssetProposalRow`. Not viewed in a browser.

## App tint and the reviews inbox app filter (2026-11-24, [ADR 0068](adr/0068-app-tint.md))

- **App tint.** An app's pages (header, the app card and "This app" group of the left panel, page glow, primary controls, chips) take the accent of the app icon, derived so
  text always keeps WCAG contrast in both themes (see [design-system](design-system.md) "App tint"). Never on the top bar, breadcrumbs, workspace group, portfolio, workspace
  Settings, dialogs or drawers. Opt-out: account menu, "Tint the interface with the app's colours" (default on), and per app Settings, Display group, **Appearance**
  (`?section=appearance`): Auto (icon colours), Off for this app, Custom colour with a live preview and the derived tokens with their contrast. Admins (`apps.write`) change the
  per app choice; everyone can switch the tint off for themselves.
- **Reviews inbox, rows.** Each row wears its app's tint (start edge, icon ring, app name in the accent ink) so the app is clear at a glance; with the personal switch off rows are
  neutral and keep the app icon chip.
- **Reviews inbox, app filter.** The toolbar has an **Apps** combobox (next to search, no longer a checklist inside Filters): type to search by app name or bundle id, arrows and
  Enter to choose or remove, Escape closes, chosen apps are removable chips with their icon, each option shows the stored and new review counts, **All apps** resets. It lives in
  the address (`#/reviews?apps=id1,id2`, combinable with rating, store, status, response, search and the rest), is sent to the server as `appIds` (already validated per workspace
  and per visible app; see [api/reviews](api/reviews.md)), works with "Show more" paging, and an id of the address that is not a visible app is dropped. A line under the toolbar
  says what is filtered ("Reviews of Alpha and Beta, with 2 more filters.", with an All apps link); with no match the empty state names the apps and offers All apps and Clear filters.
