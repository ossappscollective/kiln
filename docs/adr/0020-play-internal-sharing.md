# ADR 0020: Google Play internal app sharing as a gated store write

Status: implemented and tested against fakes. **Never run against Google.** The list of what was not verified is in
[api/internal-sharing](../api/internal-sharing.md#unverified).

## Context

[Test builds](../api/builds.md) can download the zip a CI run uploaded and hand it to a phone. For Android a zip is not installable: the
`.aab` or `.apk` inside it has to be installed another way. Google Play offers **internal app sharing**: upload the file with the Android
Publisher API (`internalappsharingartifacts.uploadbundle` / `uploadapk`) and Google returns a link that installs it through the Play
Store, signed with the right key and without a track or a review. The request was to build this, gated.

It is a store write: a binary leaves this server for Google under the developer's account. It publishes nothing to users, so it is less
severe than a release, but this server **cannot take it back** (no delete, no list), and the link it returns installs the unreleased
product. [ADR 0019](0019-step-up-confirmation.md) already named a step-up class `internal_sharing` for it, with no route.

## Decision

1. **Same shape as the other store writes** ([0008](0008-store-rollout-writes.md), [0010](0010-store-submit.md), [0014](0014-release-management.md)):
   a server switch (`KILN_PLAY_INTERNAL_SHARING_ENABLED`, default off, separate from the download switch), a role action of its own
   (`builds.share`: owner and admin; **explicit-only for tokens**), a preview with a `confirmHash`, a typed phrase (`SHARE <package>`), the step-up
   class `internal_sharing` through `requireStepUp` (first thing after the switch), one upload in flight per app, never retried.
2. **The source is a CI artifact**, the same zips the Test builds panel lists. The preview reads only the artifact list (no download, no Google call), so it
   is cheap and free; the file inside the zip is read when the person confirms. Consequence: the preview cannot show the file's version code or SHA-256;
   it shows what it knows (package, artifact, size, the zip digest, the file name when the artifact is named for it) and says so. The apply answer carries
   the SHA-256 of the file that was sent. The `confirmHash` covers the app, package, artifact (id, name, size, digest, run, commit) and the entry chosen.
3. **One file, chosen explicitly when ambiguous.** The only `.aab` or `.apk` in the zip, or the one the caller names (`entry`); several without a name is
   `422 entry_required` with the names, never a guess.
4. **The zip is held in memory** (the download limit, `KILN_BUILDS_DOWNLOAD_MAX_MB`, applies to the zip and to the file inside it), read through the same
   guarded stream as a build download. A streaming zip reader is not written. Cost: up to twice the limit in memory for one upload; the limit is the
   administrator's lever.
5. **Unknown outcomes are reported.** Google has no read-back for this resource, so a lost answer cannot be settled the way a release is. The answer is
   `409 outcome_unknown`; the app stays blocked until a preview clears it; nothing is sent twice. Since a second upload only makes a second link (no
   user-facing change), clearing by preview is acceptable here, unlike a release.
6. **The link is a secret, handled like a credential.** Stored encrypted with the master key (AAD = workspace and row), cleared after 24 hours, never in a
   list, an audit row, an event or a log; returned by the apply and by one route for `builds.share`, `no-store`. Audit rows hold ids, a size and hashes. No
   event is sent. The 24 hour life is this server's copy, not Google's: Google's help page says links last 60 days, so a link a person copied elsewhere
   still works until Google expires it, and nothing here can revoke it.
7. **The credential is the app's Google service account** (the one used for reads and drafts). Reading it is audited (`credential.use`, purpose
   `builds.share`).

## Consequences

- Off by default: nothing changes for anyone upgrading. With it on and step-up off, owners and admins share with a preview and a typed phrase.
- The service account needs permission to use internal app sharing in Play Console (unverified which role).
- A token can share only if it names `builds.share`; with the step-up policy covering `internal_sharing` it cannot unless that class is `unattended`.
- Migration 34 adds `play_internal_shares` and `play_internal_share_claims` (with the step-up recovery code table).

## Not done

- No delete or revoke (Google offers none through the API), no list of Google's side, no version code or package check of the binary, no streaming zip
  reader, no TestFlight equivalent (Apple's flow is different and is not built), no event, no Play Console links beyond the one Google returns.
