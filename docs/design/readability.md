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
| Releases | Next step card, "Current and in progress", then older (collapsed) | Same | Unchanged. A blocked plan stays a visible warning (rule 4) |
| Release stepper | Step tiles with a status word; a two-sentence note above them | The steps | The note is one line. The conditional alerts in the steps are errors or blockers and stay |
| All apps | Six columns; pending, unfinished and new-review badges beside the status | App, platforms, status, one next action | Done. Reviews column is gone (rating sits with the app); pending, unfinished and new reviews are one "Next" action chosen by urgency; platform names are always written |

Not done in this pass (candidates, in order of value): the preview bodies themselves
(`PushPreviewBody`, `SubmitPreviewBody`, `ReleasePreviewBody`) still stack their own alerts inside
"Details", which the standalone dialogs share; `StepBuild` and `StepNotes` hold several alerts that
could follow the same fold rule; `ReleaseDetail` and `PlanOverview` were not reworked.

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
