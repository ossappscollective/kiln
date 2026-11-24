# AI assistance

Reference for the routes under `/api/workspaces/{workspaceId}/` that run AI tasks and manage the suggestions they produce. Everything is
also in `GET /api/openapi.json` (tag `ai`). The decisions behind it, including the prompt-injection design, are in
[ADR 0016](../adr/0016-ai-foundation.md). The features built on it (review reports, ASO reports, text variants, the per-app AI context, the cost cap)
are in [AI features](../ai-features.md) and [ADR 0024](../adr/0024-ai-features.md); this page is the route reference for both.

**The rule.** An AI task reads stored data, sends an allow-listed part of it to the AI provider the workspace chose, gets back JSON that
must match a schema, and stores a **suggestion** (a proposal). It changes nothing by itself. A person **accepts** a suggestion, and
accepting calls a service that already exists, with that service's own right: tracking keywords (`aso.write`), **staging** a listing text
(`changesets.write`; it reaches a store only through the previewed and confirmed draft push) or saving a reply **draft** (`reviews.triage`;
sending is a different call). Nothing in this feature pushes, submits, publishes, releases, rolls out or sends.

**Off by default, twice.** The server needs `KILN_AI_ENABLED=true` and the workspace needs the setting `enabled`. A provider, a model and
(except for a local server) a key must be set. `GET /ai/config` says which is missing.

## Rights

| Action      | Who                                   | Routes                                                                       |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `ai.use`    | members, admins, owners (not viewers) | read the configuration, tasks and suggestions; run a task; accept or dismiss |
| `ai.manage` | admins, owners                        | change the settings; test the provider; list the provider's models           |

Both are **explicit-only for API tokens**: a token holds them only when its `actions` list names them (see [tokens](tokens.md)). Accepting also
needs the right of what it creates: `aso.write` for keywords, `changesets.write` for listing text, `reviews.triage` for a reply draft; for a token
that action must be named too. `run`, `accept`, `dismiss` and the single-suggestion read have no app in the path, so a token restricted to apps
gets `403` there; `GET /apps/{id}/ai/suggestions` works for the apps of the token. Non-members get `404`; a member without the right gets `403`.

## Configuration

`GET /ai/config` (`ai.use`) and `PUT /ai/config` (`ai.manage`, same answer). No key or prompt is ever returned.

```json
{
  "state": "ready",
  "reason": "no_model",
  "server": { "enabled": true, "allowPrivateUrls": false },
  "settings": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-...",
    "baseUrl": null,
    "baseUrlSet": false,
    "monthlyTokenBudget": 500000,
    "maxOutputTokens": 4000,
    "maxInputTokens": 8000
  },
  "defaults": { "monthlyTokenBudget": 500000, "maxOutputTokens": 4000, "maxInputTokens": 8000 },
  "overridden": ["enabled", "model"],
  "providers": [
    {
      "id": "anthropic",
      "label": "Anthropic (Claude)",
      "credentialKind": "ai_anthropic",
      "credentialRequired": true,
      "needsUrl": false,
      "privacy": "The data listed for a task is sent to Anthropic. ...",
      "credentialPresent": true
    }
  ],
  "usage": {
    "month": "2026-11",
    "used": 900,
    "budget": 500000,
    "remaining": 499100,
    "runs": 1,
    "resetsAt": 1796083200000
  },
  "limits": {
    "maxConcurrentPerWorkspace": 2,
    "runsPerMinute": 10,
    "maxGoalChars": 300,
    "suggestionRetentionDays": 90,
    "...": 0
  },
  "canManage": true
}
```

- `state`: `ready`, `off_server`, `off_workspace` or `not_configured` (then `reason` is `no_model`, `no_credential`, `no_url`,
  `credential_unreadable` or `bad_url`). `reason` is absent otherwise.
- `settings.baseUrl` is the address of an OpenAI compatible server; only admins see it (others get `null`, see `baseUrlSet`).
- `PUT` body: any of `enabled`, `provider` (`anthropic`, `openai`, `openai_compatible`), `model`, `baseUrl`, `monthlyTokenBudget` (`0` = no limit here),
  `maxOutputTokens`, `maxInputTokens`, `softWarnPercent`, `priceInputCentsPerMTok`, `priceOutputCentsPerMTok`, `monthlyCostCapCents` (see [Cost](#cost-the-soft-warning-and-the-cap)); `null` resets a key to its default. All or nothing. Unknown keys are `400`. `400 invalid_setting` lists `issues`.
  The key is **not** a setting: add a credential of kind `ai_anthropic`, `ai_openai` or `ai_openai_compatible` ([credentials](../credentials.md#ai-provider-keys)).
  The settings are not part of `PUT /settings`.
- **Addresses.** The `baseUrl` must be `https` to a public host. With `KILN_AI_ALLOW_PRIVATE_URLS=true` loopback and private addresses are allowed and
  plain `http` only to the same machine (`localhost`, `127.0.0.1`, `[::1]`), which is how Ollama or LM Studio is reached. Plain `http` to any other
  address (a LAN machine, `host.docker.internal`) is refused either way: use `https` there. Cloud metadata addresses are always refused. The address is
  checked when saved and again at every call. **A refused address gets a fixed code**, so a screen can say what to do (`GET /ai/config` has
  `server.allowPrivateUrls` to say it before anything fails):
  `private_address_blocked` (a loopback, private or LAN address, or a name that resolves to one, while the operator has not set the switch) or
  `plain_http_not_allowed` (plain `http` to anything but localhost). It is `code` of the `baseUrl` entry in `issues` of `400 invalid_setting`,
  `hint` of `422 ai_not_configured` (`reason: bad_url`) on test, run and models, and `reason` of `502 ai_unavailable` when a name resolves to a private
  address at call time. The wording is chosen by the client from the code; the server's own sentence says the same: *"This server only talks to public
  addresses. To use a model on this machine or your network, the person who runs this server sets KILN_AI_ALLOW_PRIVATE_URLS=true and restarts it."*
  Metadata addresses and malformed URLs have no code (the switch would not help). In Docker `localhost` is the container itself, so a model on the host
  is not reachable that way.
- **The address is used as typed.** Nothing is added or rewritten: the call goes to `<baseUrl>/chat/completions` and the list to `<baseUrl>/models`
  (trailing slashes removed). `http://localhost:11234/v1` calls `http://localhost:11234/v1/chat/completions`; without `/v1` the call goes to
  `http://localhost:11234/chat/completions`, which most servers answer with a 404 (shown as "not found: check the address, it usually ends in /v1").
- **Budget.** Input plus output tokens per UTC month, default 500,000. A run reserves its estimated input plus its output cap before it is sent and is
  settled with the tokens the provider reported, so `used` includes runs in flight. Tokens of an answer that was rejected still count.

`POST /ai/models` (`ai.manage`) is described under [Models](#models) below. `POST /ai/test` (`ai.manage`) sends one fixed request (no workspace data) through the configured provider and answers `{ "ok": true, "provider", "model" }`
or `{ "ok": false, "provider", "kind", "message", "reason"?, "sample"? }`. `message` is a fixed sentence, never provider text. Needs both switches on. Rate limited.

**The one exception: `sample`.** When the answer of an OpenAI compatible server cannot be used (`kind: invalid_output`, `reason` `not_json`, `truncated`, `schema` or
`no_text`), the test also returns `sample`: the first 300 characters the model wrote, control characters removed, to be shown as **plain text** (the settings card
shows it in a small monospace block under "What the model answered (first 300 characters)"). It exists because a small local model can fail in ways nobody can guess
from a code, and it is safe to return because the request is fixed: it holds no workspace data, so the answer cannot echo any. It is returned **only** by this route:
a task run (`POST /ai/tasks/{id}/run`) never returns or stores a sample (its prompts hold review and listing text), and audit, events, usage rows and logs never hold it.

**Small local models (OpenAI compatible only).** The request carries `temperature: 0`. A server that answers 400 or 422 naming `response_format` (strict schema, then JSON
mode, then none), `temperature` or `stream` is asked again without that field. If the first answer ends in `truncated` or `not_json`, the call is repeated **once** with a
one-line system text plus the schema as a compact example object and double `max_tokens` (at most 2,000, never below the configured value); the second error is the one
reported and the tokens of both calls are counted (a run can therefore use more than its reservation, which settling corrects). A JSON object that is only missing its
closing `"`, `]` and `}` at the very end is closed and accepted if it then matches the schema; nothing is added but those characters, a cut in a number, after a key or
right after an opening bracket is not repaired, and a string cut off stays cut off. The connection test sends the literal example `{"ok":true}` as its user message.

## Models

`POST /ai/models` (`ai.manage`, rate limited like the test) lists what a provider says it serves, so a screen can offer a pick list instead of an empty field. Body
`{ "provider": "anthropic" | "openai" | "openai_compatible", "baseUrl"?: "...", "apiKey"?: "..." }` (unknown keys are `400`). It sends **no data of the workspace**:
one read, `GET /v1/models` (Anthropic, OpenAI) or `GET <baseUrl>/models` (a compatible server; `baseUrl` of the body, else the saved one). Needs
`KILN_AI_ENABLED=true`; the workspace switch is **not** needed (this is part of setting AI up).

- **The key.** `apiKey` is a key typed in the form and not saved yet: it is used for this one call and is **never stored, logged, audited or put in an error**.
  Without it the stored credential of the provider's kind is used (decrypted for the call, audited as `credential.use`, purpose `ai`).
- **The answer** is `{ "models": [{ "id": "...", "label"?: "..." }], "source": "provider" | "fallback", "reason"?: "no_credential" | "list_unavailable" }`. Ids are
  checked (the charset and length the `model` setting accepts; anything else is dropped), deduplicated, sorted and cut at 200. Anthropic's `retired` models are
  skipped; for OpenAI, ids that obviously are not chat models (embeddings, speech, images, moderation, realtime) are left out unless that would empty the list. A
  list is only an offer: **any model name can still be typed and saved**.
- **`source: "fallback"`** means the provider's list could not be read, so `models` is a short fixed list of well known ids (Anthropic `claude-sonnet-5-5`,
  `claude-opus-5-5`, `claude-haiku-5-5`; OpenAI the flagship ids of its models page; **none** for a compatible server, whose models are whatever its owner loaded)
  and a screen should say so quietly. `reason: list_unavailable`: the server answered 404, 405, 501 or something that is not a list. `reason: no_credential`: a hosted
  provider and no key typed or saved yet; nothing was asked.
- **Errors** are the usual fixed ones: `409 ai_not_enabled` (server), `422 ai_not_configured` (`reason` `no_url`, `bad_url` with a `hint` as above, `credential_unreadable`),
  `422 ai_auth` (the provider refused the key), `429 ai_rate_limited`, `502`/`504 ai_unavailable` (`reason` `timeout`, `connection`, `http_500`, `private_address_blocked`, ...).
- **Audit** `ai.models_list`: the provider, where the key came from (`typed`, `stored`, `none`), the outcome (`provider`, `fallback`, `failed`) and a count. Never an address,
  a key or the list.

## Tasks and what they send

`GET /ai/tasks` (`ai.use`):

```json
{
  "state": "ready",
  "provider": { "id": "anthropic", "label": "Anthropic (Claude)", "privacy": "..." },
  "tasks": [
    {
      "id": "keyword_ideas",
      "version": 1,
      "label": "Keyword ideas",
      "description": "...",
      "status": "ready",
      "proposalKind": "keywords",
      "acceptAction": "aso.write",
      "scope": [
        { "name": "locale", "required": true, "description": "..." },
        { "name": "country", "required": false, "description": "..." }
      ],
      "disclosure": { "sends": ["..."], "neverSends": ["..."] }
    }
  ]
}
```

**Show `disclosure` and `provider.privacy` before the first use of a task.** `status: "planned"` tasks are listed with their disclosure plan and answer
`409 task_not_available` when run: `release_notes`, `rank_drop_explain`.

| Task                    | Scope (body fields)                                                                          | Proposal           | Accepting                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `keyword_ideas`         | `locale` (required), `country`, `goal`                                                       | `keywords`         | tracks the chosen terms (`aso.write`)                                     |
| `listing_improve`       | `locale` (required), `fields`, `goal`                                                        | `listing_text`     | stages the texts, source `ai` (`changesets.write`)                        |
| `review_reply_draft`    | `reviewId` (required), `tone` (`friendly`, `neutral`, `apologetic`), `replyLanguage`, `goal` | `reply_draft`      | saves a reply draft (`reviews.triage`, needs `KILN_REVIEW_REPLY_ENABLED`) |
| `review_summary`        | `days`, `limit`, `locale`, `outputLanguage`, `refresh` (see [review-summary.md](review-summary.md)) | `insight`          | marks it reviewed (`ai.use`)                                              |
| `review_classify`       | `days` (default 90), `limit` (1 to 40, default 20), `reviewIds`                              | `insight`          | marks it reviewed; the tags are stored by the run                         |
| `fix_next`              | `days` (default 30), `limit` (5 to 80, default 40)                                           | `insight`          | marks it reviewed                                                         |
| `listing_audit`         | `locale` (required), `goal`                                                                  | `insight`          | marks it reviewed                                                         |
| `aso_health`            | none                                                                                         | `insight`          | marks it reviewed                                                         |
| `keyword_ideas_reviews` | `locale` (required), `country`, `days` (default 90), `goal`                                  | `keywords`         | tracks the chosen terms (`aso.write`)                                     |
| `listing_variants`      | `locale` (required), `fields`, `count` (2 to 5, default 3), `goal`                           | `listing_variants` | stages one chosen variant per field (`changesets.write`)                  |
| `listing_translate`     | `sourceLocale` and `locale` (the target), both required, `fields`                            | `listing_text`     | stages the texts (`changesets.write`)                                     |

`goal` is at most 300 characters (longer is `400`, not cut). Review text is data: it is delimited, cut to 2,000 characters, and the name, device and
version of the reviewer are not sent.

## Running a task

`POST /ai/tasks/{taskId}/run` (`ai.use`). Body: `appId` plus the scope fields of the task (unknown fields are `400`). Answers `201` (`warning` is `null` unless a limit is near, see [Cost](#cost-the-soft-warning-and-the-cap)):

```json
{
  "warning": null,
  "suggestion": {
    "id": "...",
    "appId": "...",
    "task": "keyword_ideas",
    "taskVersion": 1,
    "kind": "keywords",
    "status": "proposed",
    "provider": "anthropic",
    "model": "claude-...",
    "proposal": {},
    "scope": { "locale": "en-US", "country": "us", "goal": true },
    "inputHash": "<sha-256 of the data sent>",
    "usage": { "inputTokens": 700, "outputTokens": 200 },
    "createdBy": "...",
    "createdAt": 1766000000000,
    "decidedBy": null,
    "decidedAt": null,
    "accepted": null
  }
}
```

`proposal` by `kind`. Every item has `acceptable` and `flags`; an item with `acceptable: false` is shown and **cannot be accepted**. `reason` and `text` were
written by a model: show them as plain text, never as markup.

```json
{ "kind": "keywords", "store": "app_store", "country": "us", "locale": "en-US",
  "items": [{ "term": "hydration tracker", "reason": "...", "field": "keywords", "acceptable": true, "flags": [] }] }

{ "kind": "listing_text", "locale": "en-US",
  "fields": [{ "field": "keywords", "text": "water,hydrate", "reason": "...", "length": 13, "limit": 100, "unit": "bytes",
               "acceptable": true, "flags": ["trimmed"] }] }

{ "kind": "reply_draft", "reviewId": "...", "store": "appstoreconnect", "text": "...", "length": 120, "limit": 5000,
  "acceptable": true, "flags": [] }
```

Flags: `already_tracked`, `duplicate`, `invalid_term`, `field_not_for_store` (keywords); `over_limit` (kept for reading, not acceptable), `trimmed` (a keywords
text lost entries from the end to fit its byte limit), `unchanged`, `not_stageable`, `empty` (text); `markup`, `over_limit`, `empty`, `cleaned` (reply). `field` of a
keyword idea is the listing field it would help in, or `null` (track only). `listing_improve` offers the fields a draft push can write: App Store `description`,
`keywords`, `promotional_text`; Google Play `title`, `short_description`, `full_description`. Limits are checked on the server in the store's unit.

Errors (all JSON `{ "error", "message", ... }` with fixed sentences; never provider text):

| Status   | `error`                                      | Meaning                                                                                                                                                                                               |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400      | `invalid_request`                            | bad body; `issues` lists fields                                                                                                                                                                       |
| 404      | `not_found`, `unknown_task`                  | no such app, review or task                                                                                                                                                                           |
| 409      | `ai_not_enabled`                             | `reason`: `server` or `workspace`                                                                                                                                                                     |
| 409      | `task_not_available`                         | a planned task                                                                                                                                                                                        |
| 422      | `ai_not_configured`                          | `reason`: `no_model`, `no_credential`, `no_url`, `credential_unreadable`, `bad_url` (then often `hint`: `private_address_blocked`, `plain_http_not_allowed`)                                          |
| 422      | `no_listing_text`                            | no stored listing text for that language                                                                                                                                                              |
| 422      | `ai_input_too_large`                         | the data is over the input cap; nothing was sent                                                                                                                                                      |
| 422      | `ai_auth`, `ai_too_large`                    | the provider refused the key, or says the request is too large                                                                                                                                        |
| 429      | `ai_budget_exhausted`                        | `budget`, `used`, `resetsAt`; nothing was sent                                                                                                                                                        |
| 429      | `ai_busy`, `rate_limited`, `ai_rate_limited` | too many runs now (`Retry-After`)                                                                                                                                                                     |
| 502      | `ai_invalid_output`                          | the answer did not match the schema (`reason`: `not_json`, `truncated`, `schema`, `no_text`, `refusal`); no suggestion; tokens still count; no sample of the answer                                   |
| 502, 504 | `ai_unavailable`                             | the provider could not be reached or answered with an error; `reason` is a short hint (`timeout`, `http_404`, `http_500`, `private_address_blocked`, `plain_http_not_allowed`, `address_not_allowed`) |

Audit: `ai.run` (suggestion id, app id, task, version, provider, model, token counts, `inputHash`, scope) and `ai.run_failed` (code and counts). **Never a prompt, an
answer, a review text, a goal or a key.** Event `ai.suggestion_created` with `suggestionId`, `appId`, `task`, `taskVersion`, `kind` ([events](events.md)).

## Reports, variants, context, preview and cost

Details of each task, with the design reasons, are in [AI features](../ai-features.md). The route facts:

**Proposal kinds added.** `insight` is a report, not something to apply; `listing_variants` offers several alternatives per field.

```json
{ "kind": "insight", "insight": "review_summary", "period": { "days": 30, "from": 0, "to": 0 }, "reviewCount": 40, "analysed": 25,
  "sentiment": { "positive": 10, "neutral": 5, "negative": 10 }, "overview": "...",
  "themes": [{ "label": "...", "kind": "issue", "summary": "...", "count": 6, "reviewIds": ["..."], "averageRating": 1.8 }], "notes": [] }

{ "kind": "listing_variants", "locale": "en-US",
  "fields": [{ "field": "promotional_text", "limit": 170, "unit": "characters",
               "variants": [{ "text": "...", "reason": "...", "length": 18, "acceptable": true, "flags": [] }] }] }
```

`insight` is one of `review_summary`, `review_classify`, `fix_next`, `listing_audit`, `aso_health`. In every report the **numbers are counted by the server**
(reviews per theme, shares of stars, versions, lengths, coverage, ranks); the model only writes the words, an evidence id it cites that was not in the data is dropped
(and said in `notes`), and a rank-like claim that the data does not hold gets `unverified_number`. Review ids in a report are the ids of this app's reviews; review text,
author, device and territory are never in a proposal.

**Flags added** (item, field or variant level): `banned_term` (a word of the app's `bannedWords`; **not acceptable**), `personal_data` (an email, link or number in a reply; **not
acceptable**), `risky_promise` (a reply or a release note promises something: a date, a refund, "will be fixed"; a warning), `unverified_number`, `brand_term_missing` (a
translation left out a name of `brandTerms`; a warning).

**Accepting.** `{ "choices": [{ "field": "promotional_text", "variant": 1 }] }` for `listing_variants` (at most one variant per field; without `choices` the first acceptable
variant of each field is taken; a chosen variant that is not acceptable is `422 nothing_acceptable`). `result` is `{ "kind": "listing_text", ... }` as for a staged text. An `insight` needs
no body and answers `{ "kind": "insight" }`: it only marks the report as reviewed (`ai.use`); nothing else is created or changed.

**Preview.** `POST /ai/tasks/{taskId}/preview` (`ai.use`, rate limited, **no provider is contacted and no token is spent**). Same body as a run. Answers
`{ "preview": { "task": { "id", "version" }, "input": { }, "system": "...", "estimatedInputTokens": 900, "maxOutputTokens": 2000, "includesAppContext": true, "provider": "anthropic",
"model": "..." } }`: the exact data a run would send, built from stored data by the same code, and the instruction text. Same failures as a run before the call (`422 no_reviews`, `no_listing_text`, ...).

**The AI context of an app.** `GET /apps/{id}/ai/context` (`ai.use`) and `PUT /apps/{id}/ai/context` (`apps.write`, so admins and owners). Body and answer:
`{ "about", "audience", "tone", "brandVoice", "bannedWords": [], "brandTerms": [], "doList": [], "dontList": [] }` plus `updatedAt`, `updatedBy` and (GET, PUT) `canEdit`. `PUT` replaces the
whole context (a missing field is cleared; all empty deletes it). Limits: `about` 600, `audience` 300, `tone` 120, `brandVoice` 600 characters; 30 words of at most 40 characters in
`bannedWords` and `brandTerms`; 8 rules of at most 160 characters in each list. Too long is `400 invalid_request` with `issues` (never cut). Unknown keys are `400`. Audit `ai.app_context_update` holds
the **names** of the fields that changed, never the text. Only the filled-in parts reach a task, as `appContext` in its data, and only for tasks that use it (`review_classify` does not).

**Review tags.** `GET /apps/{id}/ai/review-tags?ids=a,b,c` (`reviews.read`, 1 to 100 ids): `{ "tags": [{ "reviewId", "topics": [], "sentiment", "severity", "language", "needsReply" }] }` for the
reviews that were tagged. It reads our own database and contacts no provider. Topics are one of `crash`, `bug`, `performance`, `login`, `sync`, `billing`, `price`, `ads`, `ui`,
`feature_request`, `privacy`, `notifications`, `support`, `onboarding`, `content`, `praise`, `other`; `sentiment` is `positive`, `neutral`, `negative` or `mixed`; `severity` is `none`, `low`, `medium` or
`high`. The tags are **advisory**: they never change a review's status, assignee or reply. A tagged review is not sent again until its text or the task version changes (`nothing_to_do` when
nothing is left to tag).

**Cost, the soft warning and the cap.** Providers bill in money, the budget counts tokens. Three optional settings fix that: `priceInputCentsPerMTok` and `priceOutputCentsPerMTok` (whole cents per
million tokens; `0` = not set) give an **estimate** of the month's cost, `monthlyCostCapCents` (`0` = none) refuses a run whose estimate would pass it, and `softWarnPercent` (default 80, `0` = off) is the share
of either limit from which a warning is shown. `GET /ai/config` `usage` then also holds `estimatedCostCents`, `costCapCents`, `pricesSet`, `byTask` (`[{ task, runs, inputTokens, outputTokens, costCents }]`) and
`warning` (`null`, or `{ "kind": "tokens" | "cost", "level": "soft" | "limit", "percent", "message" }`). A run answers `{ "suggestion", "warning" }` with the same `warning` after the run. A soft warning never blocks
anything; at 100% the existing `429 ai_budget_exhausted` (tokens) or the new `429 ai_cost_cap_reached` (`capCents`, `estimatedCents`, `resetsAt`; nothing was sent) applies. The estimate is **not a bill**: it
uses prices an admin typed and the token counts the provider reported.

Errors added to a run: `422 no_reviews` (nothing to look at in the period), `409 nothing_to_do` (every review already has tags), `422 no_data` (nothing stored to report on), `422 goal_needed` (release notes alone
need a goal), `429 ai_cost_cap_reached`.

## Suggestions

- `GET /apps/{id}/ai/suggestions?status=&task=&limit=` (`ai.use`, app scoped): `{ "suggestions": [...] }`, newest first, `limit` default 20, at most 100.
  `status` is `proposed`, `accepted` or `dismissed`.
- `GET /ai/suggestions/{suggestionId}`: `{ "suggestion": {...} }`.
- `POST /ai/suggestions/{suggestionId}/accept` (`ai.use` and the right of the mechanism). Optional body `{ "items": [0, 2], "fields": ["keywords"], "replace": false }`
  (`items` for keywords, by position; `fields` for listing text; `choices` for variants, see above; no body accepts everything acceptable). Answers `200 { "suggestion", "result" }` where `result` is ids only:
  `{ "kind": "keywords", "keywordIds": [...], "created": 2, "existing": 0, "rejected": 0, "locale": "en-US", "country": "us", "remaining": 0 }` (the keywords
  are tracked for THIS app's platform and that market, with the tag `ai`; `remaining` is how many ideas are still open), `{ "kind": "listing_text", "stagedFields": ["keywords"], "locale": "en-US" }` or
  `{ "kind": "reply_draft", "reviewId": "...", "draftId": "..." }`.
  **Keyword ideas accepted in part** (`items` names some of the acceptable ones): they are tracked, the suggestion stays `proposed`, and the ideas
  taken are rewritten in its `proposal` as `already_tracked` and not acceptable. The rest can be accepted or dismissed later; the suggestion becomes
  `accepted` with its last open idea. Each accept is audited as `ai.suggestion_accepted` (with `partial` and `remaining`).
- `POST /ai/suggestions/{suggestionId}/dismiss`: `200 { "suggestion" }`; nothing is created.

Accept errors: `403 forbidden` (with `action`), `404 not_found`, `409 suggestion_not_proposed` (already accepted or dismissed; only one accept wins),
`422 nothing_acceptable` (what you chose is flagged not acceptable), `409 staged_exists` (a different text is staged for a field; send `replace: true`),
`409 draft_exists` (a different reply draft exists; send `replace: true`), `409 reply_not_editable` (the reply was sent or is being sent), and the refusal of the
mechanism passed on (for example `409 reply_disabled`, `422 field_not_pushable`, `422 too_many_items`, `422 keyword_limit`); then the suggestion is `proposed` again.
Suggestions are kept 90 days and deleted with their app.

## Review privacy (per app)

What reviews of an app may be sent to the provider ([ADR 0065](../adr/0065-ai-review-privacy-and-competitor-schedule.md)). The workspace settings
`reviewsToAi` (default `true`) and `competitorReviewsToAi` (default `false`) in `PUT /ai/config` (`ai.manage`) are the ceiling; an app can only narrow them.

- `GET /workspaces/{ws}/apps/{id}/ai/review-privacy` (`ai.use`): `{ stored: { ownReviews, competitorReviews: "on"|"off"|null, detail: "text"|"full"|"ratings", redact }, effective: { own, competitor: { choice, allowed, locked, reason: "workspace_off"|"app_off"|null }, detail, redact }, ceiling, updatedAt, updatedBy, canEdit }`. `null` follows the workspace.
- `PUT` the same path (`apps.write`): any of the four fields; answer as GET. Audit `ai.review_policy_update` with each change as from-to.
- `POST .../ai/review-privacy/preview` (`reviews.read`): `{ allowed, reason, detail, redact, reviews[], sampleOf }`, the newest 3 reviews exactly as they would be sent. Calls no provider, sends nothing.
- `DELETE /workspaces/{ws}/apps/{id}/ai/summaries` (`apps.write`, destructive): deletes the stored review summaries and what-to-fix reports of the app; answer `{ deleted }`. Audit `ai.summaries_delete`. The policy row, tags and AI context stay.

Refusals, before anything is read or sent: `409 ai_reviews_disabled` (`reason`: `workspace_off` or `app_off`; the web codes `ai.reviewsDisabledApp`, `ai.reviewsDisabledWorkspace`) for
`review_summary`, `fix_next`, `review_classify`, `review_reply_draft`, `keyword_ideas_reviews`; and `409 ai_reviews_need_text` when `detail` is `ratings` and the task needs text. An app of
another workspace answers `404`.

## MCP and agent hook

Documentation only; nothing is built. An MCP server or an in-app assistant should drive **these routes**, not a provider, so the switches, budget, flags, audit and
rights stay in one place:

1. `GET /ai/tasks` to list tools, with `disclosure` shown to the human who enables the tool.
2. `POST /ai/tasks/{id}/run` as a tool call; the result is a suggestion id and a proposal, never an effect.
3. `POST /ai/suggestions/{id}/accept` and `dismiss` only after a person approved in the client (they are `risk: write` in the OpenAPI document).
4. Give the assistant's token `actions` that name `ai.use` and only the accept rights it should have (for example `aso.write` but not `changesets.write`). Leave `store.*`, `reviews.reply` and
   `releases.*` out: this feature never needs them.

## UNVERIFIED

The request and answer shapes of the three providers were written from their documentation and never run against a live endpoint (see ADR 0016). Check with a real key before relying
on: the model lists (Anthropic `GET /v1/models?limit=1000` with the `x-api-key` header, whose docs show `Authorization: Bearer`; OpenAI `GET /v1/models`; `GET <base>/models` on Ollama, LM Studio and vLLM) and the fixed fallback ids (OpenAI: `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`, read from its models page on 2026-11-19); Anthropic `output_config.format` and the `anthropic-version` header; OpenAI Responses `text.format` with `strict: true`; `response_format` on Ollama, LM Studio and vLLM; which models support
structured outputs; token counts reported by each provider; the 3-characters-a-token estimate.
