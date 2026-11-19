# Research: Itsyconnect (ideas only)

Date: 2026-11-19. Subject: Itsyconnect, a macOS (Electron) and self-hosted client for App Store Connect.
Sources: the public README of `nickustinov/itsyconnect-macos` and a read-only walk through the running
app (one team, one app with iOS and macOS records, a second set of apps in the portfolio). Nothing was
saved, submitted, replied to or changed in the app or in App Store Connect.

## 0. Licence and rules for use

- The README states MIT. We are Apache-2.0 and a third-party design is not ours to copy.
  **Nothing from Itsyconnect may be copied: no code, no wording or help text, no icons, no layouts
  reproduced pixel for pixel.** This file records ideas and observations in our own words. Implement from
  our own design system (`docs/design-system.md`) and our own copy.
- The LICENSE file page itself was not fetched (rate limited); the README line was used.
- Not viewed: the AI Insights panel on Reviews and Analytics (it would call the user's AI provider),
  the Markers list beyond its empty state, translate/"Fix all issues" actions, Screenshots tabs for iPad
  and Watch, the macOS store listing, anything behind Save, Submit, Send reply or Mark as seen.
  The app's data was not changed. One unexplained observation: the "Review center" badge changed from 70 to
  66 during the session. Nothing I clicked marks reviews; most likely a background sync.

## 1. Feature inventory (what it does, where it lives)

Navigation is one left sidebar with three labelled groups, plus a header bar on each page.

| Area | Where | What it does |
| --- | --- | --- |
| App switcher | top of sidebar | Searchable list of apps with the numeric id under each name; shortcuts Cmd+1..n jump to an app. |
| Team switcher | bottom of sidebar | Several App Store Connect teams (API key per team); "Add team", Settings, Report an issue. |
| Overview | Release > Overview (Cmd+0) | One card per platform and live version: state pill (Prepare for submission, Ready for distribution), build and date, big version number. Cards for total downloads, proceeds, crash-free rate, two small charts. "New version" button (version and platform only). "Markers" dialog for dated annotations on charts. |
| Store listing | Release (Cmd+L) | Per version and locale: What's new (4000), Promotional text (170), Description, Keywords chips with counters, URLs, Copyright, Build picker, release method (automatic, manual, scheduled), 7-day phased rollout toggle. Small sparkle icons next to fields open AI actions. |
| Screenshots | Release | Tabs per device family (iPhone, iPad, Watch); a card per size with pixel dimensions and count; "Add variant" chips for the other sizes. |
| App details | Release | App-level (no version switcher): ids, base language, name and subtitle with counters, privacy URLs, categories, age rating, content rights, server notification URLs. |
| App review | Release | Per version: notes for the reviewer, demo account toggle, contact details. |
| Reviews | Insights (Cmd+R) | Rating summary (average, histogram), filters (sort, time, rating, territory, hide responded), review cards with Reply, Mark as seen, an inline developer response that can be edited or deleted, "Translate" for foreign text. Reply dialog: public-visibility warning, character counter, optional AI guidance, "Help me write". |
| Analytics | Insights (Cmd+I) | Tabs Overview, Acquisition, Usage, Crashes, Performance; date range menu; KPI tiles, downloads, proceeds, top territories, conversion funnel, sessions by app version, crashes by version and device. Empty charts say why (for example performance needs diagnostics sharing). |
| Keywords | Insights | Tab "My locales": one budget bar for all locales (76 of 100), warnings such as a keyword that duplicates the app name or subtitle, a per-locale accordion with chips. Tab "Storefronts": pick a country, see how many locales that storefront indexes, total budget (76 of 1000), "untapped locales" with "+100 chars, indexed in N storefronts" and a link to add that locale. "Fix all issues" action. |
| TestFlight Builds | TestFlight (Cmd+B) | Platform and version switchers; summary strip (total, first, latest); table with build, version, state and expiry, groups, installs, sessions, crashes, invites, feedback, uploaded; bulk select. |
| Build detail | row click | Header stats, **"What's new" text of the build (the TestFlight "what to test")**, groups with add/remove, individual testers, Expire build, Notify testers. |
| Groups | TestFlight | Internal and external groups with tester and build counts, public link, New group. |
| Beta app info | TestFlight | Per locale beta description, feedback email, review contact, license agreement. |
| Feedback | TestFlight | Counters (feedback, screenshots, crashes), filters (type, time, build, platform), "Hide completed"; empty state is one dashed box. |
| Portfolio | Cmd+P | All apps: totals, proceeds chart, a card per app with downloads, proceeds and a status line such as "iOS 1.4.2 Rejected" in red. |
| Review center | below Portfolio | Reviews of all apps in one stream with an app filter, "Mark all as seen", and a red count badge on the sidebar item. |
| Settings | app menu or team menu | General (updates, **Diff mode**, local MCP server with copy-ready setup for Claude Code, Codex, Cursor, OpenCode), Appearance (theme, UI language), Teams (issuer and key ids, Test connection), AI (provider list: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek; own API key; separate Gemini key for screenshot translation). |
| Also in README | n/a | AI translation of fields and whole locales, AI keyword ideas, review translation and reply drafts, appeal text for unfair ratings, screenshot translation, App Store nominations, Docker self-hosting, local SQLite with keychain-held master key. |
| Header bar | every version page | Breadcrumb, then three pickers in a fixed order: platform, version (with state dot), locale (searchable, "Primary" tag). Save (Cmd+S) at the right, refresh icon. |
| Footer bar | store listing | A readiness checklist (Build, Screenshots, Name, Description, What's new, Keywords, Support, Privacy, Copyright, Contact) with a dot per item and a "Submit for review" button that stays disabled until the list is complete. |

Keyboard shortcuts seen in the sidebar: Cmd+0 overview, Cmd+L listing, Cmd+R reviews, Cmd+I analytics,
Cmd+B builds, Cmd+P portfolio, Cmd+S save, Cmd+1..n apps. The menu bar is minimal (no View items). The
README documents no shortcuts.

## 2. Layout and UX patterns worth adopting (ideas, our own execution)

1. **Three-pick header (platform, version, locale), in that order, on every versioned page.** One place
   answers "what am I looking at"; pages without a version (App details) simply omit pickers.
2. **Version picker shows state in the list** (a dot plus a word, "Prepare for submission", "Ready for
   distribution"). The user never opens a version to learn its state.
3. **Locked-version state.** A live version shows a quiet banner ("live, only X can change without a new
   review"), fields become read-only and Save and Submit disappear. Clear, cheap, avoids disabled-field guessing.
4. **Readiness checklist in a sticky footer, wired to the submit button.** Turns "did I forget something"
   into a visible list; the same list can be our pre-push check.
5. **Diff mode (stage locally, review a before/after diff, push in one batch).** Matches our staged
   tray; confirms the model is right and that review of the diff is the key step.
6. **Keyword budget meter at three levels** (per field, per locale, per storefront across the locales it
   indexes), plus overlap warnings and "untapped locales". This is the most reusable ASO idea.
7. **A sidebar badge for work that waits** (unanswered reviews, red count) and a cross-app stream for it.
8. **Numbered app switcher with search and Cmd+1..n**, ids shown under names (useful when names collide).
9. **Dense, quiet density**: 14px body, hairline borders, rounded cards, one dark accent button per page,
   state shown with a coloured dot plus a word (never colour alone).
10. **Empty states say what is missing and why** ("requires enough users with diagnostics sharing"),
    instead of an empty chart.
11. **Settings stays out of the app sidebar** (reached from the account menu with a Back link): keeps the
    release workflow free of configuration noise.
12. **Local MCP server with copy-ready install snippets per coding tool**: a strong pattern for our
    automation docs; we already have API tokens and webhooks.

## 3. What it lacks or does worse than our plan

- Apple only: no Android or Google Play (no rollout percent, no release tracks, no Play listing
  limits of 500 for what's new, no feature graphic). Our common model has to cover both.
- No GitHub or CI link at all: it cannot start a workflow, show which run made a build, or notice
  "build uploaded, nothing submitted". Its release flow starts in App Store Connect, not in the repo.
- No repository source of truth (fastlane or Expo metadata, change sets, pull-from-store into repo).
- Single-user desktop: no roles, no audit log, no webhooks, no approvals.
- Reviews: "Mark as seen" is the only triage; no assignee, status or notes; no low-rating rules.
- ASO: counts and budgets only; no rank tracking over time, no competitors, no suggestions based on
  store search data (AI ideas only). We already have rank, competitors and gaps in `apps/web` (aso).
- Analytics are App Store Connect analytics only, with no cross-store view and no release markers from
  CI (it has hand-made "markers" only).
- The build picker said "No eligible builds for version 3.1.1" without saying why or which build is
  closest; no what's-new history; no copy of a build's TestFlight text into the version.
- The headline number of unanswered items is app-wide only; no per-release "forgotten" signal.

## 4. Mapping to our use cases

Repo state checked: `docs/ux-ia.md` (proposal; some of its "gaps" list is already out of date),
`apps/web/src/components` (app shell, ci, release, listing, reviews, aso, assets dirs exist),
`docs/api/ci.md`. Analytics: no screen and no mention in docs or `packages/core`.

### UC1. Trigger a release through GitHub Actions
- Itsyconnect: nothing; it starts after the build exists.
- We have: workflow list, declared `workflow_dispatch` inputs, dispatch dialog, runs table, "running now",
  run-to-build linking (`components/ci`, `docs/api/ci.md`). Server tested against a fake GitHub only.
- Gap: the start is under Builds and CI, not at the head of a release; no "start release" action that
  chains to the next step; no per-platform run chips on the release row.
- Recommend: a "Start release" button on the release row and app dashboard that opens the dispatch dialog
  prefilled (version, platform), then shows the run inline and offers "Prepare" when the build appears.

### UC2. Prepare, draft, check, confirm, push
Steps: select build (iOS) or promote (Android), changelog, screenshots if needed, draft release, check and
confirm (Android rollout value), push.
- Itsyconnect: iOS only; Select build button, what's new field, screenshots tab, footer checklist,
  release method, phased toggle, Save then Submit. Diff mode for review before push.
- We have: staged tray, push as draft, submit dialog with checks, rollout preview dialog, release
  fields and plan checklist, gated writes (`docs/ux-ia.md` section 5). Listing matrix, release notes drafts.
- Gap: one linear "release wizard" that keeps these in order and in one place; no build picker that shows
  eligibility reasons; Android promote and rollout value are separate from the checklist.
- Recommend: a release page with a stepper (Build, Notes, Assets, Review, Confirm) whose last step is the
  typed confirmation we already designed; every step has the Itsyconnect-style readiness dot; the Android
  confirm step requires the rollout percent; "No eligible builds" must say why (not processed, wrong
  version, expired, wrong platform).

### UC3. See that a release triggered from GitHub was never finished
- Itsyconnect: only per-app states in Portfolio ("Prepare for submission", "Rejected"); a version stuck in
  Prepare is visible but there is no time or build signal.
- We have: `AttentionList` and `app-attention.ts` with items for drift, staged-not-pushed, "draft pushed,
  ready to submit?", overdue plans, CI sync failures, review counts.
- Gap: no rule that joins "workflow run succeeded or build appeared" with "no draft, no submit, no release
  after N hours".
- Recommend: attention item "Build 412 uploaded 6 h ago by run #88; version still in Prepare / no
  submission" with deep link to the release step; mirror it as a Portfolio status line, a sidebar badge and
  an optional webhook/notification. Use the same state vocabulary as the Itsyconnect version picker.

### UC4. View analytics
- Itsyconnect: the most complete part: overview, acquisition, usage, crashes, performance, funnel,
  territories, date range, markers, portfolio roll-up.
- We have: nothing built or documented.
- Gap: whole feature. Needs App Store Connect analytics and sales reports, Play Console reports (Play
  data is limited and delayed; verify what the API exposes before promising parity).
- Recommend: start small: downloads, proceeds, crash-free rate, rating and version adoption on the app
  dashboard with a date range; add release markers automatically from our own releases (an advantage over
  its hand-made markers); defer funnel and territories.

### UC5. Follow and answer reviews so none is forgotten
- Itsyconnect: Review center across apps, red badge, "Mark all as seen", Hide responded, filters, inline
  developer response with edit and delete, reply dialog with AI help, translate.
- We have: reviews inbox with j/k/t/r keys and search, triage status, assignee, notes, rating overview,
  reply dialog and translation (reply gated by `MRM_REVIEW_REPLY_ENABLED`), attention item for new reviews.
- Gap: we are ahead on triage; behind on a persistent badge and a default "needs answer" view that mixes
  stores; "Hide responded" as a one-click default.
- Recommend: sidebar badge of unanswered reviews (per store and total), a default filter "unanswered, newest
  first", and a daily digest webhook for reviews older than N days without a reply; keep the reply
  confirmation sentence from `ux-ia.md`.

### UC6. ASO coaching for a beginner
- Itsyconnect: budget meters, overlap warnings, storefront view with untapped locales, AI keyword ideas.
- We have: keyword tracking with rank, competitors, coverage gaps, ideas, fit checks, markets (`components/aso`).
- Gap: we track; we do not coach. A beginner needs "what to do next" in order.
- Recommend: an "ASO checklist" card on the ASO page: 1 fill the keyword field (budget meter 0 to 100),
  2 remove duplicates of the name or subtitle, 3 add the keywords you rank near page one for, 4 add 3
  competitors, 5 try one extra storefront locale (untapped locale list). Show effort and expected benefit in
  plain words; link each step to the field.

### Changelog features
- Pick TestFlight "what to test" as the changelog: Itsyconnect shows the text on the build detail but
  the version's What's new is a separate empty field and the build picker does not offer it. We have the
  TestFlight store id (`lib/stores.ts`) but no build-notes field. Recommend: when a build is picked, offer
  "Use this build's test notes" (read-only read of the build localization) and show a diff against the
  current text; never overwrite without a click.
- Pick from history (like Google Play's release-notes history): neither app has it. Recommend: a
  "Reuse notes" menu on the notes field listing earlier texts with the release and date that used them
  (data we already store in plans and listing history: `HistoryDrawer`), filtered by locale.
- Limits: show 4000 for the App Store and 500 for Google Play in one counter each (already in
  `ReleaseNotes.svelte`); on reuse, warn when the old text exceeds the target limit.

### Common UX across iOS, macOS, Android
- Itsyconnect uses a platform picker that lists only platforms the app has plus "New platform". Our
  `ScopeControl` (iOS, macOS, Android, Both) is richer; keep it, but adopt the fixed header order
  platform, version, locale, and make the version list carry the state word for every platform.
- Use identical field names and checklists on every store, with a chip for store-only fields
  ("iOS only", "Android only"); one rollout control concept (Apple phased release, Play staged rollout).
- Reviews belong to the iOS record for macOS (already handled; keep the "see iOS" link).

## 5. Prioritised improvements

| P | Item | Why | Effort |
| --- | --- | --- | --- |
| P0 | "Release left unfinished" attention item joining run, build and release state (UC3), plus badge | the user's stated pain; no competitor has it | 3 to 5 days |
| P0 | Release wizard/stepper with readiness dots and a footer-style checklist (UC2) | one place for the main job; reuses submit and rollout work | 5 to 8 days |
| P0 | Build picker with eligibility reasons, and "use build test notes" as changelog (UC2) | closes the exact gap seen in the app | 3 days (needs a TestFlight read) |
| P1 | Notes history menu ("reuse notes", with release and date) | speeds every release; Play-like | 2 to 3 days |
| P1 | Unanswered-reviews badge, default view and digest (UC5) | removes forgetting | 2 days |
| P1 | Header with platform, version (with state), locale pickers across pages | common UX, fewer clicks | 2 to 3 days |
| P1 | Start-release button wired to the dispatch dialog (UC1) | shortens the first step | 1 to 2 days |
| P1 | Keyword budget meters at field, locale and storefront level, overlap warnings, untapped locales | best ASO idea; beginner friendly | 3 to 4 days |
| P2 | ASO checklist coach (UC6) | turns tracking into guidance | 3 days |
| P2 | Analytics MVP: downloads, proceeds, crash-free, adoption, automatic release markers (UC4) | large and data limited; verify store APIs first | 2 to 3 weeks |
| P2 | Locked-version banner and read-only states for live versions | clarity; small | 1 day |
| P2 | Searchable app switcher with Cmd+1..n, and global shortcuts for sections | power use | 1 to 2 days |
| P2 | Copy-ready MCP/automation snippets in Settings | developer friendly | 1 day |
