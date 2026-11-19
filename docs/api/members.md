# Members and invitations API

People join a workspace by invitation link. Registration stays closed after the first account.
There is no email delivery: the owner or admin copies the link and sends it themselves. Email
(SMTP or a webhook) can be added later without changing this API, because the token is returned
once at creation and never stored.

All workspace routes need a session cookie. A non-member and a missing workspace both answer 404;
a member without the right answers 403. Errors are `{ "error": "<code>", "message"?: "..." }`.

## Roles and rules

| Action                                                         | Who                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| See the member list (`members.read`)                           | owner, admin, member                                                  |
| Invite, revoke, change roles, remove others (`members.manage`) | owner, admin                                                          |
| Invite an `admin`                                              | owner only                                                            |
| Invite an `owner`                                              | nobody (the role is not accepted)                                     |
| Change roles / remove                                          | owners: anyone. Admins: members and viewers only, to member or viewer |
| Remove yourself                                                | anyone, except the last owner                                         |
| Demote or remove the last owner                                | nobody: 409 `last_owner`                                              |

The rules live in `packages/core/src/members.ts`; the UI uses the same functions.

## Workspace routes

`:wid` is the workspace id.

- `POST /api/workspaces/:wid/invitations` body `{ email, role }`, role is `admin`, `member` or
  `viewer`. Returns 201 `{ invitation, token }`. The token is shown once; only its SHA-256 is stored.
  Link: `<origin>/#/invite/<token>`. Expires after 7 days (`INVITATION_TTL_MS`), single use.
  409 `already_member`, 409 `already_invited` (one pending invitation per address).
- `GET /api/workspaces/:wid/invitations` pending invitations, never with tokens.
- `DELETE /api/workspaces/:wid/invitations/:id` revoke. 204, or 404 if not pending.
- `GET /api/workspaces/:wid/members` `{ members: [{ userId, email, displayName, role }] }`.
- `PATCH /api/workspaces/:wid/members/:userId` body `{ role }`. 204.
- `DELETE /api/workspaces/:wid/members/:userId` 204.

## Public routes (the person with the link)

- `GET /api/invitations/:token` returns `{ workspaceName, email, role, valid: true }`.
  Unknown, expired, used and revoked tokens all answer the same 404 `not_found`.
- `POST /api/invitations/:token/accept`
  - Not signed in: body `{ displayName, password }` (password at least 12 characters). Creates the
    account with the invited email, adds the membership, starts a session (cookie). 201
    `{ user, workspaceId, role }`. 409 `account_exists` if that email already has an account
    (sign in first, then accept).
  - Signed in as the invited email (case-insensitive): empty body. Adds the membership. 403
    `email_mismatch` for any other user, 409 `already_member`.
  - Accepting is atomic: one `UPDATE ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND
    expires_at > now` decides the winner when requests race.
  - Failed attempts are counted per token with the login rate limiter: 429 `too_many_attempts`.

In single-user mode every invitation route answers 403 `disabled_in_single_user_mode`.

## Audit events

`invitation.create`, `invitation.accept`, `invitation.revoke`, `member.role_change`,
`member.remove`. Tokens are never recorded.
