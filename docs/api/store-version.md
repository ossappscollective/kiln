# Create the next App Store version (a reversible store write, off by default)

The release stepper needs an editable App Store version to attach a build to. When there is none, a person can create the
next one here instead of going to App Store Connect. Design and the arguments: [ADR 0031](../adr/0031-create-app-store-version.md).

**App Store Connect only** (iOS and macOS records). Google Play has no such thing: a version there is a release, made in the
release steps. A Google Play app gets `422 not_supported`.

**Not run against a real account**: the request body follows Apple's documented API and is only tested against a fake. See
[UNVERIFIED](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right gets 403.

## The gate

- **Switch**: the same one as the draft push, `MRM_STORE_DRAFT_WRITE_ENABLED=true` (default `false`). While it is off both routes
  answer `409 store_draft_disabled` after the rights check, and no store is contacted. There is no new variable.
- **Right**: `store.push_draft` (owner and admin; a token only when its actions name it).
- **Step-up**: the create is the `store.push_draft` action of [step-up](step-up.md). A workspace that covers it asks for the
  person's confirmation (a grant in the `x-step-up-grant` header, bound to the app and the `confirmHash`); the preview stays free.
  There is no typed phrase: the version can be deleted in App Store Connect while it is in Prepare for Submission.

## `POST /apps/{id}/store-version/preview`

Body: `{ versionString, releaseType? }`. `versionString` is one to three numbers separated by periods (`3.1.2`).
`releaseType` is `MANUAL` or `AFTER_APPROVAL` and is left out by the web app (the store's default applies).

READS the versions of the record's platform (the macOS record reads the macOS versions) and writes nothing. A successful read
also settles an earlier unknown outcome of a create. Returns `{ preview }`:

| Field                          | Meaning                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `app`, `request`               | What is asked, for which record.                                                                    |
| `live`                         | The newest version the store lists that cannot be edited (`null` when none).                        |
| `suggested`                    | The next patch of `live` (`3.1.1` is `3.1.2`, `3.1` is `3.1.1`, `2` is `2.0.1`; `1.0` when none).   |
| `versions[]`                   | `{ versionString, state, editable }` of every version of the platform.                              |
| `checks.blocking` / `warnings` | `{ code, message }`. A blocking check stops the create.                                             |
| `confirmHash`                  | A SHA-256 over the app, the request and the versions as read. `null` while anything blocks.         |
| `reversible`, `note`           | Always `true`; and the sentence "Creates an editable draft version... Nothing is submitted."        |

Blocking checks: `invalid_version`, `version_exists` (the string exists in any state), `not_higher` (not higher than `live`),
`editable_version_exists` (a version in Prepare for Submission or a rejected state already exists: attach the build to it).
Warning: `version_in_progress` (another version is in review or waiting for release; Apple may refuse).

## `POST /apps/{id}/store-version`

Body: `{ versionString, releaseType?, confirmHash }`. Needs the switch, the right and, when covered, the step-up grant.

1. The versions are **read again** right before the write. A different list is `409 state_changed` with a new `preview`; a
   blocking check is `409 blocked` with `checks`. Nothing is written in either case.
2. One `POST /v1/appStoreVersions` with `platform` (`IOS` or `MAC_OS`, the record's), `versionString`, `releaseType` when given, and the
   app. It writes the version only: no text, no build, no submission, no release.
3. **One write in flight** per app and platform, in the claim table of the draft push, so a push and a create exclude each
   other (`409 write_in_progress`).
4. **Never retried.** After a timeout or a 5xx the versions are read back: the version shows (`200` with
   `confirmedByReread: true`), or the answer is `409 outcome_unknown`: look at the app in App Store Connect, then preview again.
   Nothing is created until a new preview is confirmed.
5. Apple's refusals (a 409 for a version that is not allowed, a 403 for a key without the right role) are `422` with Apple's own
   reasons in `details[]` (`code`, `title`, `detail`, `pointer`).

Returns `{ result }`: `app`, `version { id, versionString, state }`, `reversible: true`, `confirmedByReread`, `warnings[]`,
`createdAt`, `note`. After it, sync the app and the stepper finds the version.

**Audit**: `store.version_created` and `store.version_create_failed`: ids, the version string, hashes and outcomes. Never a
credential, a token or a store response body. No event is emitted.

## UNVERIFIED: check with a real account

- The request body (`type: appStoreVersions`, `attributes { platform, versionString, releaseType? }`, `relationships.app`) is from
  Apple's documentation, never sent to Apple. Any 2xx counts as created.
- That the states `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED` and `INVALID_BINARY` are the editable ones
  (the draft push's list), and the state names read from `appVersionState` / `appStoreState`.
- Which role the key needs to create a version (an App Manager or Admin key is assumed).
- Whether Apple allows a new version while another is in review: the warning `version_in_progress` only says it may refuse.
