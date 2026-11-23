# ADR 0051: Insights cards, store page checks and country language coverage

Status: accepted (2026-11-23). Ideas adapted from the Growth tools of Open Screenshot Generator (MIT, see THIRD_PARTY_NOTICES.md).

## Context

Kiln stores analytics, reviews, rank history and the live store listing, but nobody reads them together. A person has to
notice that "German visitors have no German page" or "the subtitle repeats the name" by looking at five screens.

## Decision

- **Rule engine, no AI.** `packages/core/src/insights/engine.ts` runs deterministic rules over data Kiln already has and
  returns cards: category (visibility, conversion, downloads, markets, reviews, keywords, listing), severity, a headline with
  the key number, evidence, and one or two actions that name a place in Kiln (page, view). A rule whose data is missing is
  skipped and the response says why, so the empty state is honest. Cards are sorted problems first, then by weight.
- **Dismissal with a fingerprint.** `insight_dismissals` (migration 55) keeps one row per app and card id with the
  fingerprint of the finding at the time. A dismissed card stays hidden while its fingerprint is unchanged and comes back when
  the finding changes. Dismiss and restore need `aso.write`; reading needs `analytics.read`.
- **Store page checks** (`listing-checks.ts`): per locale, wasted keyword space, words already in the name or subtitle,
  a subtitle that repeats the name, limits (from `packages/core`, not retyped), untranslated locales, missing promotional text;
  score 0 to 100. Read-only: a suggested keyword text is shown with a copy button. Staging the fix through pending changes
  is a follow-up. Needs `listing.read`.
- **Language coverage** (`language-coverage.ts`, `countries.ts`): downloads by country joined with the country's main language
  (a table in core) against the live store page locales. Needs `analytics.read`.
- **Review themes** (`review-themes.ts`): keyword counting in English, French, Spanish and German for repeating complaints.

## Consequences

- No new external call and no AI cost; every number can be traced to stored data.
- The theme and main-language tables are maintained by hand and cover the languages Kiln is translated into plus common ones.
- Thresholds (for example "two 14 day windows", a pooled z test at about 95%) are in the engine and unit-tested; they are
  defaults, not tuned on real accounts. UNVERIFIED: how often each rule fires on real data.
