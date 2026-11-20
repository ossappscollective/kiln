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
