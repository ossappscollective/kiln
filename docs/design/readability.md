# Readability: what is first on each screen

Feedback: the screens carry a lot of information, and it hides the important part (in the publish
dialog, the steps and the next action). This page is the audit and the rules. Not a redesign: it
uses the existing tokens and components.

## The rules

1. One primary thing per screen: the current step and the single next action. It comes first and is
   the most visible thing.
2. Status second (one pill or word per fact; never two badges that say the same thing).
3. Warnings and explanations third, shortened. One short warning stays on its line. Two or more, or
   a long one, fold behind one "Details" line ("2 things to read before you confirm").
4. A blocking problem is never folded: it stays visible and says what to do.
5. An irreversible-action warning stays, but as ONE short line next to the action (and a badge on
   the step), not stacked alerts above the steps.
6. Keep headings, `aria` and the `data-testid`s.

The pure parts live in `apps/web/src/lib/readability.ts` (`foldWarnings`, `planHeadline`,
`shownStatusWord`, `stepGist`, `capItems`) and `rowNextAction` in `lib/app-overview.ts`, all tested.

## Audit, screen by screen

| Screen | First today | Should be first | Done |
| --- | --- | --- | --- |
| Publish dialog | Up to four stacked alerts (info, "This writes to", "cannot be undone", "Read before you confirm") above the steps; each step opened with its whole diff | The headline ("2 steps will be written to X", in order) and the steps, each with its numbers; then warnings; the diff on request | Done. Headline and steps first. The "writes to" and "cannot be undone" alerts are one line each at the confirmation; warnings fold behind one line; step diffs and explanations sit behind "Details of this step"; "Ready" is not repeated on a ticked step. Errors and a plan that cannot be published stay visible |
| App overview | "Next step" card (already first), then CI runs, tiles, Details. The card could grow long with "Also needs attention" | Next step, then release state (Live / In flight per platform), then details | The list under the card shows three lines (and every urgent one) with "Show N more". Order unchanged: it was right |
| Releases | Next step card, "Current and in progress", then older (collapsed), then rollout controls | Same | Order was right. The table is set in 16px rows with 13px heads, and "Rollout controls" has a section heading with one sentence (what it is for) above its changes. A blocked plan stays a visible warning (rule 4). The page header and "Next step" card belong to `components/app` |
| Release stepper | Five wide tiles with a status word and a note above them; each step opened with a paragraph | Where am I and the one next action | Done (mockups `stepper-build` and `stepper-confirm`). The steps are a left rail (number or check, name, one line of status); the step is on the right with ONE heading and ONE sentence (`stepIntro`); the footer is always at the bottom: Back, "Step N of M" and the one primary, "Next: <step>", on the last step "Review and publish" (`footerFor`). Build: one line per build (number, version, uploaded, ONE chip), the chosen/attached/newest first and highlighted, newest 3 with "Show all", and the long sentence, CI run, "Install to test" and TestFlight line behind "Details of the selected build", which opens by itself only when the selected build has a warning or cannot be chosen. "Use this build" and "Stage the notes" are secondary buttons that appear only when there is something to stage, with one line beside them. Notes: TestFlight reuse is a disclosure. Assets and Review: "nothing" is one line (no staged line, no intro). Confirm: a numbered list of what will be written, in order, with "Cannot be undone from here" on the step it applies to (`confirmSteps`); the single steps sit behind "Do just one step (advanced)" |
| All apps | Six columns; pending, unfinished and new-review badges beside the status | App, platforms, status, one next action | Done. Reviews column is gone (rating sits with the app); pending, unfinished and new reviews are one "Next" action chosen by urgency; platform names are always written |

### Publish dialog (second pass)

Mockup `publish-dialog`. The title says what happens (`publishTitle`: "Release 2.9.0 to the App Store",
"Submit 2.9.0 for review on ...", "Update the draft on ..."). Each step is a card with its tick, its
numbers and "Details of this step". The confirmation is ONE box: with no required phrase it is a single
tick ("I understand. ... cannot be undone from here ...", or "I have read the plan" when nothing is
irreversible) plus one line that the person confirms with a password or passkey, no phrase to type; the
typed phrase appears, inside the same box, only when the plan says `confirmationRequired`. The footer
says in one line why Publish is off (`publishDisabledReason`: making the plan, out of date, tick a step,
type the phrase, tick the box). `PushPreviewBody` shows ONE "Read before you confirm" list (the server's
warnings and the store's warning checks together, no duplicates). The plan, hash, phrase and step-up
logic are untouched.

Not done (candidates): `SubmitPreviewBody` and `ReleasePreviewBody` keep their own sections ("What cannot
be undone from here") because the standalone dialogs share them; `StepNotes` still holds several
conditional alerts for translation and history; `ReleaseDetail` and `PlanOverview` (the full release
page) were not reworked beyond what the page header already does.

## Applied globally (2026-11-20, mockups approved)

The direction of `docs/design/mockups/` applies to every screen, in this order of work: Prepare release and the publish dialog (the
stepper), then the shell and the overview (this section), then the other pages as they are touched.

| Part | What it is now |
| --- | --- |
| Left panel (`AppNav`, `Shell`) | A card with the app and one status line per platform (tint, name, state and version; `lib/app-status.ts`). Labelled groups "This app" and "Workspace". Count badges only for what needs you (releases left unfinished, changes waiting on Store listing, unanswered reviews; All apps and Inbox in the workspace group). Current page: tint, bar and heavier label. 15px text. Secondary workspace pages stay under "More" |
| App header (`AppShell`) | Page name (24px) over the app name and bundle id; platform control, Sync, Status and settings at the right |
| Pending changes (`PendingBar`, `pendingPlacement`) | On the Overview one link in the Next step card; elsewhere a slim neutral line; a blocking error stays a visible warning bar everywhere |
| Overview (`AppDashboard`, `NextStep`) | "Your next step" card (30px title, 17px sentence, one large primary button, the five release steps), platform cards side by side with tint and status, "Also worth a look" (three lines, "Show N more"), Details collapsed |
| All apps (`Portfolio`, `AppsOverview`) | The same page header as the other workspace pages (title, one sentence, primary "Add app" at the right); the next action of a row is a visible pill |
| Page headers (`PageHeader`, `app.css`) | 24px title, 15px one-line explanation, the primary action at the right. Inbox and Settings already used it |
| Settings (`Settings`, `settings/*`) | One-sentence header. General opens with Store refresh (it is what makes alerts work), then Reviews, Releases, Translation; a "Jump to" row (`JumpTo`, `settingsSectionsFor`) scrolls to a part (buttons, not hash links, because the address is a route). Security keeps confirmation, recovery codes, the second factor and mail together, each with a jump target. Hints are one sentence; the long explanation of the refresh sits behind "How the refresh works". The save bar is sticky and says "You have unsaved changes" or "All changes are saved" |
| Alerts (`Alerts`, `alerts/*`) | The inbox starts with one line (`inboxHeadline`: "2 need attention, 3 unread") and Mark all read only when something is unread; "Needs attention" is open first, "For your information" opens only when nothing needs attention, "Resolved" is folded. The unread count is on the tab. In My alerts, the Desktop notifications card stays first; "Try it" and an empty mute list are folded; hints are one sentence |
| Reviews inbox | Shorter header sentence and empty state; summary strip and filters were already one line and one disclosure |
| Credentials | Uses `PageHeader` with "Add credential" as the one primary; the empty state is one line plus the action; Delete is a danger link, not equal to Test and Replace secret; 15px table text |
| Members, API tokens, Webhooks, Repositories | One-sentence headers; Members gets "Invite someone" as the header action (it focuses the invite form below); one-line footers; 15px table text. Revoke, Remove and Delete stay `danger` and secondary to the safe actions |
| Workflows, Audit log | Already had `PageHeader`, one primary and filters on one line; unchanged |

### The pages of an app (2026-11-20)

The pages the left panel of an app links to open with `ui/PageLead`: one headline that says where the page stands (a
sentence, 20px), one short sentence under it (15px), and the page's actions at the right, with at most one primary. The page
name is the app header's; the lead is status plus the next action, not a second title. The headlines are pure
(`lib/page-lead.ts`: `reviewsLead`, `buildsLead`, `keywordsLead`, `settingsLead`, `needsAnswerText`, tested).

| Page | What it is now |
| --- | --- |
| Store listing (`ListingMatrix`) | Lead: "3 locales need attention, 1 with missing fields" (or "All locales are in sync"), the stores and locale count, one sentence on how editing works (pencil, staged, nothing reaches a store until published), and ONE primary "Show the N locales that need attention". The two muted paragraphs and the status line are gone. Chips and the locale grid are 15px with roomier cells. "Staged changes" keeps its slim line; the two long notes sit behind "How staged changes reach a store" |
| Reviews (`ReviewsTab`) | Lead: "5 reviews need an answer, oldest 3 d" with ONE primary "Show unanswered"; "Read reviews now" becomes secondary (primary only when nothing waits; none in the empty state, which has its own). Last read, "About reviews" and the "Replying is switched off" pill sit under the headline. The old quiet chip inside the rating summary is gone (`data-testid="unanswered-chip"` moved to the lead). Customer text is 15px, titles 17px |
| Builds (`BuildsPanel`) | Lead: "12 builds, 3 without a CI run" with when tags were searched; "Re-run matching" and "Build number conventions" at the right. The "No repository is linked" alert is one sentence in the lead. "How builds are matched" is collapsed (it opened by itself when a build was unlinked). Table 15px, cell notes 14px |
| Test builds (`TestBuilds`) | Lead with the count, the one-line purpose and "Read again"; the long explanation sits behind "About test builds" |
| Insights, Keywords (`AsoSection`) | The tracked keywords come first (they are what you decide on), under a one-line lead ("12 keywords tracked, 3 in the top 10", and "N not checked yet. Press Check now"); "Keywords your listing uses now" moves below. The stat chips in the action bar are gone (the lead says it) |
| Insights, Overview (`AnalyticsPlatform`, `AnalyticsOff`) | The order was right (figures, one chart, more charts folded). "Analytics is off" is one sentence and the turn-on button; what it reads sits behind "What it reads". Delta lines, captions and notes are 13 to 15px |
| App settings (`AppSettings`) | Lead: a failing sync first ("The last sync failed for Android", where to look), then a record never synced, otherwise "Stores are connected"; Collapse all and Expand all beside it. Section text 15px. The Danger zone stays collapsed |

Not done (candidates): the locale drawer and field editor of Store listing, `ReplyDialog`, the ASO views behind "More",
`AppWorkflows` (already two muted sentences and the panels), the Graphics view of Store listing (`components/assets`), and the
sub-sections of Settings (their forms keep their own copy).

## Store and platform markers

iOS, macOS and Android are told apart by four signals, so no single one carries the meaning:

- A **name** in text ("iOS", "macOS", "Android") beside every marker. Icon-only is kept only where
  the name stands right beside it (`showLabel={false}`).
- A **tint** per platform from tokens (`--platform-ios-*` sky, `--platform-macos-*` violet,
  `--platform-android-*` lime; `bg`, `ink`, `line`). Defined in `app.css` and mirrored in
  `lib/tokens.ts`; light and dark; ink on its background and on the surface is checked at 4.5:1 in
  `contrast.test.ts`.
- A **glyph silhouette**: tall phone with a pill (iOS), rounded square with a grid (Android), wide
  display (macOS).
- An **official logo**, when the maintainer adds one (below).

`ui/PlatformBadge.svelte` is the one component (the old `portfolio/PlatformBadge.svelte` wraps it).
`ScopeControl` uses it too.

### Adding the official logos (maintainer)

The built-in glyphs are generic shapes. They are deliberately not the Apple or Android logos: those
are trademarked and are not drawn or approximated here. To show the real marks, download them from
each owner and use them under their brand guidelines (Apple: Marketing Resources and Identity
Guidelines; Android: Android brand guidelines; check the rules for macOS and for use beside the
word "iOS"). Then drop the files in:

```
apps/web/src/assets/platforms/ios.svg
apps/web/src/assets/platforms/macos.svg
apps/web/src/assets/platforms/android.svg
```

`PlatformBadge` loads whichever of the three exists (`import.meta.glob`, `lib/platform-logos.ts`)
and shows it inside the tinted tile, 16 px. A missing file falls back to the generic glyph, so
the three can be added one at a time. Rebuild the web app (`pnpm build` in `apps/web`). Use a logo
that reads on both the light and the dark tint, or ask for a mono variant; also list them in
`THIRD_PARTY_NOTICES.md`.
