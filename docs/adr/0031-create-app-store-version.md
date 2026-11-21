# ADR 0031: Creating the next App Store version from the release stepper

Status: implemented and tested against fakes; **never run against App Store Connect** (see
[api/store-version](../api/store-version.md#unverified-check-with-a-real-account)).

## Context

The build step of the release stepper needs an editable App Store version. When there is none it said "Create the next
version in App Store Connect, sync this app, then read again here", a dead end that sends the person out of the app for
a step that carries no risk. [ADR 0009](0009-staged-store-drafts.md) deliberately kept version creation out of the draft
connector ("nothing here creates a version"), so this needs its own decision.

## Decision

1. **A separate connector and service**, not a method on the draft connector. The draft interface still cannot create a
   version; `AppleVersionConnector` can create one and nothing else (no text, build, submission or release).
2. **Gated like the draft push, with no new switch or right.** `MRM_STORE_DRAFT_WRITE_ENABLED` turns it on, `store.push_draft`
   is the right, and the step-up action is `store.push_draft`. A new version is a draft that App Store Connect lets a person delete
   in Prepare for Submission, so it belongs with the other reversible draft writes, not with submit or release.
3. **Preview, then confirm with a hash; no typed phrase.** The hash covers the app, the request and the versions as read. The
   versions are read again right before the write and any difference is `409 state_changed`. Because the write is reversible, a
   click on a clearly worded button (with the person's confirmation when the workspace's step-up covers the action) is enough.
4. **Checks are data.** A version string that is not one to three dotted numbers, one not higher than every version that cannot
   be edited, one that exists, and an existing editable version all block. The editable states are the draft push's own list
   (`APPLE_DRAFT_VERSION_STATES`). Another version in review is a warning: Apple decides.
5. **One write in flight, shared with the draft push**: the same claim table (`store_draft_claims`, action `create_version`),
   so no migration. A create and a push exclude each other, and an unknown outcome of a push is not settled by a version preview.
6. **Never retried; a lost answer is read back.** The versions are read again: the version shows (`confirmedByReread`), or the
   answer is `409 outcome_unknown` and the person looks in App Store Connect. Not showing is never taken as "not applied".
7. **Apple's reasons are surfaced** (`details[]`, from `appleErrorDetails`), because the likely failures (a 409 for a version
   Apple does not allow, a 403 for a key's role) are fixed by the person in App Store Connect.
8. **Audit holds ids and the version string**, never a credential or a store body. No event is added.
9. **Google Play is not touched.** A version there is a release; the route answers `422 not_supported`.

## Consequences

- The web app prefills the next patch of the newest version it knows (`nextVersion` in `@kiln/core`) and lets the person change it.
- After a create the app is synced from the web app (the same announcement a publish makes), so the stepper finds the version.
  The server does not sync by itself.
- Whether Apple accepts the request body and which key roles may create a version are unverified.
