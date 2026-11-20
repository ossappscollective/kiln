# ADR 0019: Step-up confirmation for hard actions

Status: implemented and tested on SQLite with a software authenticator. **Never run with a real
authenticator, a real browser, or the desktop shell's web view.** The list of what was not verified is in
[api/step-up](../api/step-up.md#unverified).

## Context

The app can publish to the stores, hand a version to review, release it, change a live rollout, turn on
Apple analytics reports and delete credentials. Each of these already needs a role, a preview, a hash and
often a typed phrase ([ADR 0008](0008-store-rollout-writes.md), [0010](0010-store-submit.md),
[0015](0015-pending-and-batch-publish.md)). Those protect against a slip, not against someone else holding
the session: an open laptop, a stolen cookie, a cross-site script. The request was a confirmation step,
"maybe even with password/biometry". The session cookie lasts 30 days, so "you are signed in" is weak proof
that the person at the keyboard is the owner right now.

## Decision

1. **A fresh proof, once per hard action.** A person proves themselves with a **passkey** (WebAuthn, user
   verification required: Touch ID, Face ID, Windows Hello, a PIN, a security key) or a **password**, and
   receives a **grant**: 32 random bytes, stored only as their SHA-256, bound to the **session**, the person,
   the workspace, the **action class** and optionally a **target id and hash** (the preview or plan hash the
   person saw). It lasts **5 minutes** and is **spent by its first use**. It travels in the header
   `X-Step-Up-Grant` (or the body field `stepUp`), never in a URL.
2. **Policy per workspace**, `security.stepUp`: `off` (the default, so nothing changes for anyone upgrading) or
   `hard_actions`, with the covered classes: `store.publish`, `store.submit`, `store.release`, `rollout`,
   `internal_sharing`, `analytics.enable_apple`, `credential.delete`, `flags` (turning `analytics.enabled` or
   `translation.enabled` on), and `store.push_draft` (opt-in: a draft never reaches users). It is stored in
   `workspace_settings` under its own key, not in the settings registry, so the ordinary settings route
   cannot change it. Owners and admins change it. **The recommendation is ON**; the default is OFF only for
   compatibility.
3. **Not enrolled means refused, with a way forward.** When the policy covers an action and the person has no
   way to confirm, the action answers `403 step_up_not_enrolled`, which says where to add one. Enrolling the
   first factor needs nothing; changing factors afterwards needs a fresh confirmation (class `step_up.manage`,
   always enforced when a factor exists), so a stolen session cannot slip its own passkey in. Weakening an
   active policy needs one too.
4. **Factors.** (a) **Passkeys**, verified with `node:crypto` only (no library, no network): attestation
   `none`, ES256 (-7) and EdDSA (-8) keys, `userVerification: required`, origin, RP id, type and challenge
   checks, a signature counter that must go up once it is in use, challenges that are single use and last 2
   minutes and are bound to the session (and, for an assertion, to the action and target). Other attestation
   formats and RS256 are refused rather than half-verified. (b) A **confirmation password**: in multi-user
   mode the account password; in single-user mode (which has no password) an optional separate password set
   in Settings, hashed with the same scrypt as account passwords. Wrong answers are counted per person for
   both factors: five in a row lock confirmation for 30 seconds, doubling to 15 minutes, a success resets it,
   one check at a time per person.
5. **API tokens cannot confirm.** A token that does a covered action gets `403 step_up_required_human`, unless
   an admin put that class on the policy's `unattended` list (default empty). That is the trade-off for CI:
   an unattended class is exactly as strong as the token that holds it. The step-up routes themselves are closed
   to tokens in the registry.
6. **Where it is checked.** `requireStepUp` is the first thing the apply route does after its kill switch;
   previews stay free. Policy off returns before it reads anything. The grant is spent before the action
   runs: if the action then fails (`409 state_changed`) the person confirms again. That is deliberate.
7. **Records.** Audit rows `step_up.verified`, `step_up.failed` (with the failure count), `step_up.refused`
   (a token), `step_up.passkey_added`, `step_up.passkey_removed`, `step_up.password_set`,
   `step_up.policy_changed`, `step_up.recovery_generated`, `step_up.recovery_used`: ids and the factor type, never a password, a key, a grant or a
   code. Events `stepup.verified`, `stepup.failed` and `stepup.recovery_used` (admins read them; the names have no underscore in the first segment
   because the web's event-name test requires it).
8. **Web.** One `StepUpDialog` (primary "Confirm with Touch ID / passkey", fallback "Use password"). A screen
   wraps its call in `confirmed(...)`; only the answer `step_up_required` opens the dialog, and the same call
   is repeated once with the grant. Nothing else is ever retried. Where the window offers no WebAuthn the dialog
   says so and offers the password. Every failure sentence comes from a fixed code.
9. **Demo.** `AppDeps.stepUpAutoApprove` (one flag, per database object) makes the guard pass; nothing else
   changes.

10. **Recovery codes (added, migration 34).** Ten one-time codes per person (100 random bits each, shown once, stored as salted SHA-256, constant-time compared,
    spent by one `UPDATE`, rate limited by the same failure count and lockout as the password and the passkey). A code is a third factor for any class and for
    `step_up.manage`, which is how a lost only passkey or confirmation password is removed or replaced. Owners and admins make them (regenerating invalidates the old
    ones) after a fresh confirmation. They stand BESIDE a passkey or password (a person with neither is "not enrolled"), so a stolen session that can mint nothing without
    a confirmation cannot give itself a way in. A used code has its own audit row and event.

## Consequences

- With the policy off, every route and every existing test behaves as before.
- Passkeys need `https` or `http://localhost` and a host name (not an IP address). `MRM_PUBLIC_ORIGIN` pins the
  origin behind a proxy; otherwise the origin of the request is used.
- Losing the only factor with the policy on is recoverable only with a recovery code (decision 10). Without codes it locks hard actions
  and policy changes until someone with database access removes the rows of `step_up_users` / `step_up_credentials` or the `security.stepUp` setting.
  Making codes is optional, so the Security card nudges.
- A grant is bound to a session. Signing in again needs a new confirmation.
- A passkey that always sends counter 0 (many platform and synced passkeys) is accepted; the counter check
  only bites once a counter is in use.

## Not done

- No per-action "remember for N minutes", no attestation formats other than `none`, no
  RS256 (Windows Hello on some hardware offers only RS256: such a device cannot be enrolled, UNVERIFIED).
- Google Play internal app sharing is guarded by the class `internal_sharing` ([ADR 0020](0020-play-internal-sharing.md)).

## Amendment (2026-11-20): no typed phrase when a person confirms

When the policy covers `store.publish` and the caller is a person who can confirm (a passkey or the confirmation password), "Review and
publish all" does not ask for the typed phrase: the grant is bound to the plan hash the person saw, which is a stronger proof of intent than
a phrase (`stepUpCovers` in `services/step-up.ts`; `confirmationRequired` is false in the plan, the dialog shows its "I have read the plan"
box and then the confirmation dialog). The plan still says it is irreversible. With the policy off, for a token, or for a person with no way
to confirm, the typed phrase stays. The single steps (push, submit, release, rollout) keep their own phrases: this is only the batch.
