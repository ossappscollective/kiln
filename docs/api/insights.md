# Insights API

All routes are under `/api/workspaces/{ws}/apps/{appId}/insights` and are in the operation registry.

| Route | Right | What it returns |
| --- | --- | --- |
| `GET /` | `analytics.read` | The cards (not dismissed), category counts, and the rules that were skipped with the reason. `?dismissed=true` also lists hidden cards. |
| `GET /count` | `analytics.read` | How many visible cards: the badge of the Insights entry. |
| `GET /countries` | `analytics.read` | New downloads by country with the main language of each and whether the live store page covers it. |
| `GET /listing-checks` | `listing.read` | Per locale: score, findings (severity, explanation) and a rewritten text where one is safe. `counts` (`problems`, `warnings`, `tips`) is the one number the Highlights card and the locale panel both say: only a problem (a limit exceeded, a required field empty) makes the card red; advice is counted apart. A difference between the repository and the store is never a check. |
| `POST /cards/{cardId}/dismiss` | `aso.write` | Hides a card until its finding changes (stores the fingerprint). |
| `POST /restore` | `aso.write` | Shows dismissed cards again. |

Card ids are stable per rule and subject (`visibility`, `localize:de`, `complaints:crash`). A card carries `category`,
`severity`, a headline with its numbers, `evidence` and `actions` (a place in Kiln: page and view; the web turns it into an address).
Dismissals live in `insight_dismissals` (migration 55). Nothing here writes to a store.

UNVERIFIED: behaviour on real accounts (which rules fire, how many cards); the main-language table covers common storefronts only.
