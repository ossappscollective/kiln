# Architecture

One TypeScript codebase and one deployable. Clients call one API. The API talks to the
database, asset storage, the stores and GitHub. Builds stay in the team's own CI.

```
Web UI · Tauri shell · CLI and webhooks
                 |
        Core service (one codebase)
   API server · Domain modules · Job worker
       Database · Asset storage
                 |
   App Store Connect · Google Play · GitHub
                 |
   Apple API · Google Play API · your CI (fastlane or EAS)
```

## Rules the code follows

1. **Connectors hide the stores.** Apple and Google model releases differently (separate review
   resources versus one transactional Play edit). Only connectors know that. The rest of the
   code sees the normalized lifecycle in `@mrm/core`.
2. **Change sets are the only way to write.** UI edits, repo commits and, in V2, assistant
   suggestions all create a change set with a diff that a person approves.
3. **Every write is audited**, with the actor type (user, token, assistant, system).
4. **Secrets are encrypted before they reach the database** and bound to their owner.
5. **Read before write.** No phase writes to a store until the read-only sync matches the console.
6. **Portable data model.** Text ids, epoch-millisecond times and JSON as text, so Postgres and
   SQLite share one model.

## Release lifecycle

`draft → build_chosen → ready → in_review → approved → rolling_out → live`

with `rejected` looping back to `draft` through a fix, `halted` reachable from `rolling_out`,
and Android passing through `propagating` after release. Blocked is a flag on any state.
The dashboard groups states into preparing, in review, ready to release and live.

## Decisions

See [docs/adr](adr/0001-stack-and-license.md) and the open spikes in [docs/spikes](spikes).
