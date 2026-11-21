# ADR 0026: Keywords your listing uses, a listing editor and plain AI wording

Status: web implemented (pure logic tested; **screens type-checked with svelte-check but not run in a browser**). No server change, no migration.
Builds on [ADR 0011](0011-aso-keywords-competitors.md), [ADR 0009](0009-staged-store-drafts.md) and [ADR 0024](0024-ai-features.md). User guide: [AI features](../ai-features.md); screens: [UX and IA](../ux-ia.md).

## Context

Three pieces of real feedback: the Keywords view did not show the keywords an app already uses (the most useful thing, since the insight starts there) and
gave no way to change them; an AI keyword idea said "for the title" or "for the full description" and it was not clear whether that had been done or was
being asked; and there was no clear place to edit and ask for suggestions on the listing texts, only a per-locale drawer.

## Decision

1. **Start Keywords with what the listing uses now.** A block "Keywords your listing uses now" sits above the tracker. It is derived in the web from data it
   already loads (`GET /aso/listing-keywords`, the stored text of every locale) with `@kiln/core` (`listingRows`, the tokenizer of `aso.ts`), plus phrases cut
   from the title and the subtitle or short description (`keyword-use.ts`). App Store: the keyword field entries and the words of name and subtitle. Google
   Play: words and phrases of title, short and full description; the view says in plain words that Play has no keyword field and the list is derived. A
   locale without stored text shows an empty state that points to Sync (reading the store only copies text into the tool).
2. **Honest figures.** A used keyword shows where it appears, whether it is tracked and its latest rank. Imported Play search terms add "visitors from search":
   what the Console reports (people who searched the term and opened the listing), never presented as search volume or impressions.
3. **One editor, many doors.** `FieldEditor` edits one field of one locale: counter against the limit (bytes for the keyword field), store text against new
   text, "Suggest with AI" and "Stage". It is opened from the pencil in each cell of the Store listing grid, from the locale drawer (kept), from the Keywords
   view and from the AI keyword idea. The text to start from when a keyword is added (`addTermToText`) is a starting point to edit, never staged by itself.
4. **Staging stays the only write, and it is ours.** The editor calls the existing `PUT .../staged/text` with `from: "local"`. Nothing reaches a store; the
   push to a draft and the submit stay the gated, previewed steps. The App Store name and subtitle are not written by a draft push (ADR 0009, 0024), so for
   them the editor is a scratchpad with "Copy text" and says so; no button "stages" them. Adding that would need a different connector call and its own decision.
5. **AI wording says what it means.** "For the full description" became "Where it would go: Full description" plus "This is a suggestion for what to put there.
   Nothing changes until you stage it." Accepting a keyword idea says "Track"; putting it in the listing is the explicit "Stage in <field>" button. A text
   suggestion shows "Now" against "Suggested" with the changes marked, and its accept button names the field. The privacy line and the data preview are untouched.

## Consequences

- No new endpoint or table: the derivation can change without a migration. The list is only as fresh as the last sync of the listing, and says when it was read.
- The Play list is heuristic: stop words and short words are skipped, description words count from two occurrences (at most 30). It can miss a phrase a person
  considers a keyword; tracking one by hand still works.
- The old "In your listing" view stays under More for its "track all untracked" plan and the per-term marks.
- A suggestion staged from the editor and one staged from a proposal use the same endpoint, so the tray, the grid marks and Pending changes agree.

## Not verified

- Nothing was run in a browser: layout, focus order inside the stacked dialogs (editor above the drawer), the diff display and the wording on narrow screens need a look.
- No real store or AI model was contacted. The Play Console search terms columns are as the existing import reads them.
- Which fields a store searches is still unverified (ADR 0011); the "where it appears" column reports where the text is, not how the store weighs it.
