# ADR 0028: Release notes from the promoted release, and translating them

Status: server, web and demo implemented and tested on SQLite against fakes (a fake Google for the machine engine, a scripted fake
client for AI). The PostgreSQL cases were skipped, **no real translation or AI provider was contacted** and the web screens were checked
by the type checker and by tests of their logic, not opened in a browser.

## Context

The step "What is new" of Prepare release had two gaps. Promoting a release from a Google Play track to production started with empty
editors although the release being promoted has notes. And a person with notes in one language had to retype them in every other, or
copy the same text to all, although the workspace may already have a translation provider ([review translation](../api/reviews.md#translation))
and an AI provider ([ADR 0016](0016-ai-foundation.md), [0024](0024-ai-features.md)).

## Decision

1. **The notes of the promoted release fill the editors.** When Prepare release is opened from "Promote to production" (`from` track and
   version codes in the address), the notes of the release in the source track that holds those version codes are read (the existing
   notes history read, narrowed with `track` and `codes`; a read of the store, cached ten minutes, no new connector call) and put in the
   editors per language. Never over a text the person typed or staged. The step says where the text came from and that nothing is
   staged, or plainly that the source release has no notes or could not be read. The history entries of Google Play carry their version
   codes for this. A plain (not promoted) Android release is not prefilled: the newest earlier notes are one click away in
   "Reuse earlier notes", and guessing which of them belongs to this release is not trivial.
2. **One endpoint, two engines, text out.** `POST /apps/{id}/release-notes/translate` takes one source text and up to 40 target languages
   and returns a text per language. `machine` uses `translateText` and so the provider, credential, daily character budget and failure
   codes of review translation. `ai` uses the provider, the monthly token budget, the cost cap, the concurrency gate and the usage rows of
   the AI foundation (`runAiDirect`, which runs the same checks in the same order as `runAiTask`). Unlike `listing_translate` it creates no
   proposal: the person asked for text to read and edit in the editor that is already in front of them, and a tray round trip would add a
   step without adding a decision. The decision stays where it was: nothing is staged until the person stages it.
3. **No store write.** Nothing in this feature calls a store write path; the staging gate and the draft push are untouched. The only
   store call is the existing read of the notes history.
4. **A member can use it** (`changesets.write`, the right to stage text), with `reviews.translate` for the machine engine and `ai.use` for
   AI, as for the other uses of those providers. For a token, `ai.use` stays explicit-only.
5. **Per language, not all or nothing.** A language that fails is reported and the others are kept. A failure that would hit every
   language (not configured, budget used up, rate limit, provider down) stops the rest and, when nothing was translated, is the answer.
6. **The limit is a flag, not a cut.** The AI is asked for text within the limit of the store (500 on Google Play, 4000 on the App
   Store), told to keep line breaks, bullets, numbers and names, and to write plain text. A text that is still too long is returned and
   flagged (`over`); the editor shows the count and staging stays blocked until it is shortened. Version numbers missing from a translation
   and names of the app's AI context that were lost are flagged for a look. Machine translation cannot be told the limit.
7. **The screen asks before it replaces** (like "Copy to other languages"), shows how many texts it would replace, and says which
   setting to change (and links to it) when a provider is off or not set up.

## Data sent to a provider

The text of the one source language (at most 4000 characters), the language tags, and for AI also the store, the limit and the app's AI
context (only the filled parts, which the AI settings already say are sent). No reviews, no listing text, no credentials, no names of
people. The text is not logged, not in the audit trail, not in an error and not stored: the audit entry `release_notes.translate` has ids,
the engine, the provider, the model, counts and a code. The screen says before the first use which provider gets the text.

## Not verified

- No real provider was contacted: how Google, DeepL, Azure or LibreTranslate treat line breaks and bullets, and how well a model keeps to
  the limit, is unknown. The limit and the warnings are checked by code, not trusted.
- Region tags (`pt-BR`, `de-DE`) are passed to the machine provider as the review translation does; a provider that wants a different
  form answers `translation_unsupported_language` for that language only.
- The notes history of Google Play lists the releases the tracks hold now (at most twelve). A source release that was replaced is not found.
- The web screens were not run in a browser. The PostgreSQL variants of the server tests were skipped.
