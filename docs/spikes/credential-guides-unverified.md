# Credential guides: items not confirmed

Checked on 2026-11-18 against the vendor pages listed in `packages/core/src/credential-guides.ts`.
Each item below was not confirmed from an official page. The guide text avoids stating them as
fact, or hedges them. Confirm each one by hand in the vendor UI, then update the guide and
remove the item here.

## App Store Connect

- Which role is the minimum for this tool. Apple's role description pages give prose for Admin,
  App Manager and Developer, but the permission grid lost its marks when read, so the exact
  roles for edit metadata, submit for review and upload builds are unconfirmed. The guide
  suggests App Manager from its prose description only.
  https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions
- Whether a team key can be downloaded again. Apple states the private key is available once,
  both for team and individual keys. This was confirmed only for the key creation article.
  https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api
- Exact wording of the API access request prompt in the Integrations tab. Apple's help page says
  the Account Holder requests access; the on-screen text was not seen.
  https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/
- The Apple developer docs name the Integrations tab for key creation and the Keys tab for
  revocation. The two names may refer to the same tab. Check the live UI.
  https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys

## Google Play

- Propagation delay after inviting a service account. Google's Getting started page gives no
  figure. Third-party docs mention up to 36 hours, which is not official. The guide says only
  to wait and retry.
  https://developers.google.com/android-publisher/getting_started
- Which Play Console permissions each API call needs. Google's Getting started page names only
  the two billing permissions. The release and store listing permissions in the guide come from
  the permission definitions in Play Console Help and are matched to tasks by name.
  https://support.google.com/googleplay/android-developer/answer/9844686
- The exact name of the API in the Cloud console library. Google's docs say Google Play Developer
  API; the task brief says Google Play Android Developer API. Look for either name.
  https://developers.google.com/android-publisher/getting_started
- The Play Console API access page. Google says linking a Cloud project is no longer needed. The
  guide therefore does not use that page, and its current state in the menu was not checked.
  https://developers.google.com/android-publisher/getting_started
- Exact error text returned for a missing app permission. The guide describes it in general
  terms only.
  https://developers.google.com/android-publisher

## GitHub

- Installation ID location for a personal account. GitHub documents the organization URL
  pattern (github.com/organizations/ORG/settings/installations/ID) on the ARC page and the
  GET /app/installations call. The personal account page was not found.
  https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller/authenticating-to-the-github-api
- Who may install a GitHub App on an organization. The install page does not name the required
  organization role.
  https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
- Whether Metadata read-only is granted automatically. Observed in the UI, not confirmed from
  the pages read.
  https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- Fine-grained token permission names per endpoint. The page is very long and the Contents,
  Pull requests and Actions sections were not read. The guide reuses the GitHub App permission
  names, which GitHub documents for the same endpoints.
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- Whether a fine-grained token is shown only once. The management page does not say. The guide
  asks the reader to copy it right away.
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Whether the Workflows permission is needed to edit workflow files. The tool only dispatches
  workflows, so the guide does not request it. The permissions page for Workflows was cut off.
  https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- The page for the Pull requests permission name for create. The endpoint POST
  /repos/{owner}/{repo}/pulls was seen with write access, and the section heading was not.
  https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

## Links

- Google Cloud docs links use cloud.google.com, which currently redirects to
  docs.cloud.google.com. Add that host to the allowlist if the redirect is dropped.
