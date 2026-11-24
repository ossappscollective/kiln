# ADR 0067: Diff and preview of proposed and staged changes

Status: server and web implemented and unit/server tested; **not viewed in a browser** (diff colours, swipe/fade/difference modes and mobile layout are unverified). No migration.
API: [api/pending](../api/pending.md) (`GET /apps/{id}/pending/cart/detail`), [api/release-asset-proposal](../api/release-asset-proposal.md) (`beforeFiles`).
Builds on [ADR 0054](0054-pending-cart.md) (the cart), [ADR 0063](0063-release-asset-proposal.md) (the proposal) and [ADR 0064](0064-pending-count-and-asset-hint.md) (the workspace Pending page).

## Context

Everywhere a change is proposed or staged, a person had only an excerpt (140 characters, or a count and four thumbnails) to decide on. Reviewing a 4000 character description or a
screenshot set before publishing meant opening the page where it was made.

## Decision

Shared parts, used by every place that shows a change:

- `lib/diff/text-diff.ts`: pure, dependency free. Word level (characters for short texts and scripts without spaces, Han, Kana, Thai), line level for long or multi paragraph text with
  changed line pairs refined by words. Myers O(ND) behind a cap on the edit distance (400) and the input (20 000 characters per side); over a cap the answer falls back to coarser steps and ends
  as whole blocks (`capped`), which is still a correct diff. Line endings are normalised. Stats: words and characters added and removed.
- `components/ui/TextDiff`, `DiffModal`: inline or side by side (stacks below 640px). Added and removed text uses `<ins>` / `<del>` with underline and strike-through, not colour alone (tokens `--ok-*`, `--bad-*`).
  Characters before → after against the store limit (characters or bytes), copy buttons for both sides, previous / next across a list in the dialog.
- `lib/diff/image-diff.ts`, `components/ui/ImageDiff`, `ImageDiffModal`: side by side, swipe, fade (native range inputs: keyboard operable, no motion, so reduced motion is respected), difference
  (`mix-blend-mode: difference`), fit or 100%, size facts, an explicit state for a new, removed or failed image. "About N% of pixels differ" only when both load, have the same shape and the draw is
  allowed (a canvas of at most 512px, tolerance 16/255). Images are only Kiln's own same origin routes (CSP `img-src 'self' data:`, ADR 0049): the store thumbnail proxy by opaque `ref`, the staged blob
  route, the repository file route. No external address is ever loaded.

Where they are wired:

1. **Asset proposal card** (ADR 0063): a Diff button per text (store text against repository text) and the graphics set as a button that opens the image viewer (store images against repository files);
   previous and next run across the card's list. The proposal gains an additive `beforeFiles` per graphics item (refs of the store images the comparison already read).
2. **Pending cart drawer** (ADR 0054): every row has an expand chevron (`aria-expanded`, `aria-controls`), collapsed by default, the state kept while the drawer is open, plus Expand all / Collapse all.
   The preview is read lazily by `GET /apps/{id}/pending/cart/detail?id=` (same right as the cart, `listing.read`, stored state only; texts cut at 8000 characters, at most 30 images per side, `404` for an
   id that is not in this app's cart) and kept per item and version. Listing text: diff against the store text; release field: the staged value (the store is not read, so there is no "before"); graphics:
   before and after images by position, a click opens the viewer; price: the table that already existed; reply: the draft and the review it answers.
3. **Workspace Pending page** (ADR 0064): each app row can be expanded to its individual changes (read lazily from the per-app cart GET, which already carries the list; the summary stays counts only), each
   with the same preview and the same Expand all / Collapse all. "Open cart" stays the one place to publish or discard.

## Consequences

- No right changes, nothing is written or audited; a detail is stored state shown to people who can already read the cart.
- A release field has no "before" (no store value is stored for it); a graphics set has none when no store read is remembered (the in memory view of the Graphics tab); both are said in words.
- The staged-text compare in other places (listing editor, staged view) is out of scope.
- Unverified without a browser: diff colours in both themes, swipe/fade/difference rendering, the 640px stacking, focus order inside the dialogs.
